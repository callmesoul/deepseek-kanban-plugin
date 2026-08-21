/**
 * @deepseek-kanban/plugin — host half.
 *
 * A host-plane cordis Service (`ctx.kanban`) exposed to the browser through the
 * Typert Remote gateway under the `kanban` namespace. It owns:
 *   - the task state machine (todo → running → review → approved → done, + paused),
 *   - a JSON storage domain (`$DSH_HOME/storages/kanban.json`),
 *   - git operations (branch checkout / commit / merge) via node:child_process,
 *   - headless coding-agent execution via ctx.agents.create + agent-presets mount.
 *
 * Remote endpoints are discovered by the gateway's SRC fallback: the
 * `TypertRemoteService` binding plus `@Remote` markers recorded manually below
 * (the `Remote` decorator function is invoked by hand because this file is plain
 * JS — stage-3 decorators need a compile step we deliberately avoid).
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Service } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import z from 'zod';

const execFileAsync = promisify(execFile);

export const TASK_STATUSES = ['todo', 'running', 'paused', 'review', 'approved', 'done'];
const KANBAN_TASK_GROUP_TITLE = '看板任务';
const KANBAN_WORKTREE_MARKER = '.kanban-worktrees';
const MAX_TIMEOUT_DELAY = 2_147_483_647;
const STATUS_LABELS = {
  todo: '待领取',
  running: '执行中',
  paused: '暂停中',
  review: '待审查',
  approved: '已审核',
  done: '已完成',
};

function buildAgentPrompt(task, cwd, continuationComment = '') {
  const prompt = [
    '你是一个在独立 git 分支上执行开发任务的编程 agent。',
    '',
    `任务标题：${task.title}`,
    `任务描述：${task.description || '（无）'}`,
    '',
    `你当前的工作目录是：${cwd}`,
    `系统已经为你切好了独立分支 ${task.taskBranch}，请直接在这个目录中完成开发。`,
    '',
    '要求：',
    '- 直接修改工作目录中的代码文件，完成任务。',
    '- 不要执行 git commit / git checkout / git merge 等分支管理操作（系统会统一提交）。',
    '- 可以用 git status / git diff 查看改动，但不要提交。',
    '- 完成后简要说明你做了什么改动。',
  ].join('\n');

  const comment = (continuationComment || '').trim();
  if (!comment) return prompt;

  return [
    prompt,
    '',
    '用户评论/补充要求：',
    comment,
    '',
    '请基于上述补充继续完成剩余工作。',
  ].join('\n');
}

function messageText(content) {
  // Some surfaces deliver content as a plain string instead of blocks.
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function agentMessages(agent) {
  try {
    const session = agent?.session;
    const messages =
      typeof session?.deriveMessages === 'function'
        ? session.deriveMessages()
        : session?.messages ?? agent?.messages ?? [];
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

function extractAgentSummary(agent, startIndex = 0) {
  try {
    const messages = agentMessages(agent);
    for (let i = messages.length - 1; i >= Math.max(0, startIndex); i -= 1) {
      const message = messages[i];
      if (!message || message.role !== 'assistant') continue;
      const text = messageText(message.content);
      if (text) return text;
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Capture the agent's FINAL output for the change log.
 * The last assistant message can be committed a tick after the driver
 * reports idle, so retry briefly instead of recording a stale tail.
 */
async function awaitAgentFinalOutput(agent, startIndex = 0) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const summary = extractAgentSummary(agent, startIndex);
    if (summary) return summary;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return '';
}

// ── storage domain ──────────────────────────────────────────────────────────

const taskCommentSchema = z.object({
  id: z.string(),
  content: z.string(),
  createdAt: z.string(),
});

const taskChangeLogSchema = z.object({
  id: z.string(),
  summary: z.string(),
  source: z.enum(['agent', 'git', 'system']).default('agent'),
  commit: z.string().nullable().default(null),
  createdAt: z.string(),
});

const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  description: z.string(),
  baseBranch: z.string(),
  taskBranch: z.string(),
  worktreePath: z.string().default(''),
  status: z.enum(TASK_STATUSES),
  message: z.string(),
  agentSessionId: z.string().nullable(),
  modelProvider: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  executeAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  comments: z.array(taskCommentSchema).default([]),
  changeLogs: z.array(taskChangeLogSchema).default([]),
});

const kanbanDomain = defineDomain({
  name: 'kanban',
  version: 1,
  tables: {
    tasks: domainTable(taskSchema),
  },
});

// ── git helpers ─────────────────────────────────────────────────────────────

async function runGit(cwd, args, timeoutMs = 120000) {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
  } catch (err) {
    const detail = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    return {
      ok: false,
      stdout: (err.stdout || '').trim(),
      stderr: detail || err.message || '',
    };
  }
}

async function currentBranch(cwd) {
  const r = await runGit(cwd, ['branch', '--show-current']);
  if (r.ok && r.stdout) return r.stdout;
  const fallback = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return fallback.ok ? fallback.stdout : '';
}

async function listBranches(cwd) {
  const r = await runGit(cwd, ['branch', '--list', '--format=%(refname:short)']);
  if (!r.ok || !r.stdout) return [];
  return r.stdout.split('\n').map((b) => b.trim()).filter(Boolean);
}

async function isGitRepository(cwd) {
  const r = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout === 'true';
}

// ── project path listing (for the "/" autocomplete in description/comment) ─

const PATH_SCAN_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.parcel-cache',
  '.docusaurus',
  '.cache',
  'coverage',
  '.idea',
  '.vscode',
  '.venv',
  'venv',
  '__pycache__',
  'Pods',
  'DerivedData',
  'vendor',
]);

/**
 * Fallback directory walk for non-git projects. Skips hidden entries (except
 * `.github`) and common heavy/vendor dirs, bounded by depth and total count.
 * Returns paths relative to `cwd` with "/" separators.
 */
async function scanProjectPaths(cwd, { maxDepth = 8, maxEntries = 5000 } = {}) {
  const results = [];
  let count = 0;
  async function walk(dir, depth) {
    if (depth > maxDepth || count >= maxEntries) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= maxEntries) return;
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (PATH_SCAN_SKIP_DIRS.has(entry.name)) continue;
        results.push(rel);
        await walk(rel, depth + 1);
      } else if (entry.isFile()) {
        results.push(rel);
        count += 1;
      }
    }
  }
  await walk(cwd, 0);
  return results.map((p) => p.slice(cwd.length + 1).replace(/\\/g, '/'));
}

/** All ancestor directories of every path, so the tree is navigable. */
function deriveParentDirs(paths) {
  const dirs = new Set();
  for (const p of paths) {
    let idx = p.lastIndexOf('/');
    while (idx > 0) {
      const dir = p.slice(0, idx);
      dirs.add(dir);
      idx = dir.lastIndexOf('/');
    }
  }
  return dirs;
}

async function hasCommits(cwd) {
  const r = await runGit(cwd, ['rev-parse', '--verify', 'HEAD']);
  return r.ok;
}

async function hasUncommitted(cwd) {
  const r = await runGit(cwd, ['status', '--porcelain']);
  return r.ok && r.stdout.length > 0;
}

function worktreeRoot(workspace) {
  return join(dirname(workspace.path), `${basename(workspace.path)}.kanban-worktrees`);
}

function worktreePathFor(workspace, task) {
  return join(worktreeRoot(workspace), task.id);
}

async function createTaskWorktree(cwd, task, path) {
  await mkdir(dirname(path), { recursive: true });
  const add = await runGit(cwd, [
    'worktree', 'add', '-f', '-b', task.taskBranch, path, task.baseBranch,
  ]);
  if (add.ok) return;

  const attach = await runGit(cwd, ['worktree', 'add', '-f', path, task.taskBranch]);
  if (!attach.ok) {
    throw new Error(attach.stderr || attach.stdout || add.stderr || add.stdout || '创建 worktree 失败');
  }
}

async function removeTaskWorktree(cwd, task) {
  if (!task.worktreePath || !existsSync(task.worktreePath)) return;
  await runGit(cwd, ['worktree', 'remove', '--force', task.worktreePath]);
  await rm(task.worktreePath, { recursive: true, force: true });
}

async function mergeTaskBranch(task, workspace) {
  const cwd = workspace.path;
  const current = await currentBranch(cwd);
  const message = `Merge kanban task ${task.id}: ${task.title}`;

  if (current === task.baseBranch) {
    const merge = await runGit(cwd, ['merge', '--no-ff', '--autostash', task.taskBranch, '-m', message]);
    if (!merge.ok) throw new Error(merge.stderr || merge.stdout || '合并失败');
    return;
  }

  const tempPath = join(worktreeRoot(workspace), `merge-${task.id}`);
  await mkdir(dirname(tempPath), { recursive: true });
  const add = await runGit(cwd, ['worktree', 'add', '-f', '--detach', tempPath, task.baseBranch]);
  if (!add.ok) throw new Error(add.stderr || add.stdout || '创建合并 worktree 失败');

  try {
    const merge = await runGit(tempPath, ['merge', '--no-ff', task.taskBranch, '-m', message]);
    if (!merge.ok) throw new Error(merge.stderr || merge.stdout || '合并失败');
    const head = await runGit(tempPath, ['rev-parse', 'HEAD']);
    if (!head.ok) throw new Error(head.stderr || head.stdout || '读取合并提交失败');
    const update = await runGit(cwd, ['update-ref', `refs/heads/${task.baseBranch}`, head.stdout]);
    if (!update.ok) throw new Error(update.stderr || update.stdout || '更新目标分支失败');
  } finally {
    await runGit(cwd, ['worktree', 'remove', '--force', tempPath]);
    await rm(tempPath, { recursive: true, force: true });
  }
}

// ── Remote marker helper (plain-JS @Remote) ─────────────────────────────────

function markRemoteMethods(Klass, methods) {
  const proto = Klass.prototype;
  const dummy = Object.create(proto);
  for (const method of methods) {
    const context = {
      kind: 'method',
      name: method,
      static: false,
      private: false,
      addInitializer(fn) {
        fn.call(dummy);
      },
    };
    Remote(function noop() {}, context);
  }
}

// ── the service ─────────────────────────────────────────────────────────────

export class KanbanService extends TypertRemoteService {
  static inject = [
    'workspaceRegistry',
    'storageDomain',
    'agents',
    'agentPresets',
    'agentDefaultModel',
    'llm',
  ];

  constructor(ctx) {
    super(ctx, 'kanban');
    this.domain = null;
    this.tasks = null;
    this.branchCache = new Map();
    this.inFlight = new Map();
    this.taskTimers = new Map();
  }

  async [Service.init]() {
    this.domain = await this.ctx.storageDomain.open(kanbanDomain);
    this.tasks = this.domain.table('tasks');
    this.ctx.effect(() => () => this.domain.close(), 'kanban.domainClose');
    this.ctx.effect(() => () => this.clearTaskTimers(), 'kanban.taskTimers');
    this.restoreScheduledTasks();
  }

  // ── internal helpers ──────────────────────────────────────────────────────

  projectById(id) {
    return this.ctx.workspaceRegistry.get(id);
  }

  currentDefaultModel() {
    try {
      const selection = this.ctx.agentDefaultModel.currentSelection();
      return selection?.provider && selection?.model ? {
        provider: selection.provider,
        model: selection.model,
      } : null;
    } catch {
      return null;
    }
  }

  async listCreateTaskOptions() {
    const providers = this.ctx.llm.listProviders();
    const groups = [];
    for (const provider of providers) {
      try {
        const models = await this.ctx.llm.listModels(provider.id);
        if (!models.length) continue;
        groups.push({
          id: provider.id,
          name: provider.name,
          models: models.map((model) => ({
            id: model.id,
            name: model.name,
            ...(model.description ? { description: model.description } : {}),
          })),
        });
      } catch {
        // An unavailable provider should not block the rest of the model list.
      }
    }
    return {
      groups,
      defaultModel: this.currentDefaultModel(),
    };
  }

  isKanbanTaskWorkspace(workspace) {
    const title = workspace?.title || '';
    const path = workspace?.path || '';
    if (title !== KANBAN_TASK_GROUP_TITLE) return false;
    return path.split(/[\\/]/).some((segment) => segment.endsWith(KANBAN_WORKTREE_MARKER));
  }

  async attachAgentSessionToKanbanGroup(sessionId, cwd) {
    const registry = this.ctx.workspaceRegistry;
    if (typeof registry?.create !== 'function') return;

    // 先查找是否已存在该项目对应的看板工作区，避免重复创建
    const existing = registry.list().find((w) => {
      if (!this.isKanbanTaskWorkspace(w)) return false;
      return (w.path || '') === cwd;
    });

    if (existing && typeof existing.attachSession === 'function') {
      await existing.attachSession(sessionId);
      return;
    }

    const workspace = await registry.create(cwd, KANBAN_TASK_GROUP_TITLE);
    if (workspace && typeof workspace.attachSession === 'function') {
      await workspace.attachSession(sessionId);
    }
  }

  async setAgentSessionTitle(handle, task) {
    const title = task.title?.trim();
    let sessionTitle;
    try {
      sessionTitle = this.ctx.get?.('sessionTitle');
    } catch {
      sessionTitle = undefined;
    }
    if (!title || typeof sessionTitle?.rename !== 'function') return;
    await sessionTitle.rename(handle.agent.session, title);
  }

  async projectView(workspace) {
    const [branch, git] = await Promise.all([
      currentBranch(workspace.path),
      isGitRepository(workspace.path),
    ]);
    return {
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      branch,
      git,
    };
  }

  async listBranches(input) {
    const workspace = this.projectById(input.projectId);
    if (!workspace) return { branches: [], current: '' };
    const git = await isGitRepository(workspace.path);
    if (!git) return { branches: [], current: '' };
    const [branches, current] = await Promise.all([
      listBranches(workspace.path),
      currentBranch(workspace.path),
    ]);
    return { branches, current };
  }

  /**
   * List the project's file/directory tree (relative paths, "/" separators)
   * for the "/" autocomplete in task description / comments.
   * Prefers `git ls-files` (fast, respects .gitignore); falls back to a
   * bounded directory walk for non-git projects.
   */
  async listProjectPaths(input) {
    const workspace = this.projectById(input.projectId);
    if (!workspace) return { paths: [] };

    let files = [];
    if (await isGitRepository(workspace.path)) {
      const r = await runGit(workspace.path, [
        'ls-files', '--cached', '--others', '--exclude-standard',
      ]);
      if (r.ok) {
        files = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      }
    }
    if (!files.length) {
      files = await scanProjectPaths(workspace.path);
    }

    const set = new Set(files.map((p) => p.replace(/\\/g, '/')));
    for (const dir of deriveParentDirs(set)) set.add(dir);
    return { paths: [...set].sort((a, b) => a.localeCompare(b)) };
  }

  invalidateBranch(projectId) {
    this.branchCache.delete(projectId);
  }

  async gitBlockReason(task) {
    const workspace = this.projectById(task.projectId);
    if (!workspace) return '项目不存在';
    if (!await isGitRepository(workspace.path)) return '项目不是 git 仓库，无法签出分支执行';
    if (!await hasCommits(workspace.path)) return '仓库还没有任何 commit，无法签出分支';
    if (!task.baseBranch || !task.taskBranch) return '任务缺少 git 分支信息，无法执行';
    return null;
  }

  listTasks() {
    return [...this.tasks.entries()]
      .map(([, t]) => ({
        ...t,
        comments: t.comments ?? [],
        changeLogs: t.changeLogs ?? [],
      }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async writeTask(task) {
    task.updatedAt = new Date().toISOString();
    await this.tasks.put(task.id, task);
    return task;
  }

  patchTask(taskId, patch) {
    const current = this.tasks.get(taskId);
    if (!current) return null;
    return this.writeTask({ ...current, ...patch });
  }

  async gitChangeSummary(worktreePath) {
    const stat = await runGit(worktreePath, ['show', '--stat', '--format=', 'HEAD']);
    if (stat.ok && stat.stdout) {
      return stat.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n');
    }
    return '';
  }

  async gitCommitHash(worktreePath) {
    const rev = await runGit(worktreePath, ['rev-parse', '--short', 'HEAD']);
    return rev.ok && rev.stdout ? rev.stdout : null;
  }

  createChangeLog(summary, source, commit = null) {
    const cleaned = (summary || '').trim();
    return {
      id: randomUUID(),
      summary: cleaned || '（未提供改动说明）',
      source,
      commit,
      createdAt: new Date().toISOString(),
    };
  }

  // ── remote: projects / board ──────────────────────────────────────────────

  async listProjects() {
    const workspaces = this.ctx.workspaceRegistry.list().filter((w) => !this.isKanbanTaskWorkspace(w));
    return Promise.all(workspaces.map((w) => this.projectView(w)));
  }

  async getBoard() {
    const [projects, tasks] = await Promise.all([this.listProjects(), Promise.resolve(this.listTasks())]);
    const taskVersion = tasks.reduce(
      (latest, task) => (task.updatedAt > latest ? task.updatedAt : latest),
      '',
    );
    const projectVersion = projects.map((p) => `${p.branch}:${p.git ? 1 : 0}`).join('|');
    return {
      projects,
      tasks,
      statuses: TASK_STATUSES.map((s) => ({ id: s, label: STATUS_LABELS[s] })),
      version: `${projectVersion}|${taskVersion}`,
    };
  }

  // ── remote: create ────────────────────────────────────────────────────────

  async createTask(input) {
    const workspace = this.projectById(input.projectId);
    if (!workspace) throw new Error('项目不存在');

    const title = (input.title || '').trim();
    if (!title) throw new Error('任务标题不能为空');

    let executeAt = null;
    const executeAtInput = typeof input.executeAt === 'string' ? input.executeAt.trim() : '';
    if (executeAtInput) {
      const parsedAt = new Date(executeAtInput);
      if (Number.isNaN(parsedAt.getTime())) throw new Error('执行时间格式不正确');
      executeAt = parsedAt.getTime() > Date.now() ? parsedAt.toISOString() : null;
    }

    const modelProvider = (input.modelProvider || '').trim() || null;
    const model = (input.model || '').trim() || null;

    const project = await this.projectView(workspace);
    const baseBranch = (input.baseBranch && input.baseBranch.trim()) || project.branch;
    const ready = project.git && await hasCommits(workspace.path);
    const waiting = Boolean(executeAt && Date.parse(executeAt) > Date.now());

    const id = randomUUID();
    const now = new Date().toISOString();
    const task = {
      id,
      projectId: input.projectId,
      title,
      description: (input.description || '').trim(),
      baseBranch,
      taskBranch: project.git ? `kanban/${id.slice(0, 8)}` : '',
      worktreePath: '',
      status: ready ? 'todo' : 'paused',
      message: !ready ? (project.git
        ? '仓库还没有任何 commit，无法签出分支'
        : '项目不是 git 仓库，无法签出分支执行')
        : waiting
          ? `等待执行时间：${new Date(executeAt).toLocaleString('zh-CN', { hour12: false })}`
          : '',
      agentSessionId: null,
      modelProvider,
      model,
      executeAt,
      createdAt: now,
      updatedAt: now,
      comments: [],
      changeLogs: [],
    };

    await this.tasks.put(id, task);
    if (ready) {
      if (waiting) {
        this.scheduleTaskTimer(id, Date.parse(executeAt));
      } else {
        this.schedule(() => this.runTask(id));
      }
    }
    return task;
  }

  // ── remote: manual status moves ───────────────────────────────────────────

  async moveTask(input) {
    const task = this.tasks.get(input.taskId);
    if (!task) throw new Error('任务不存在');
    const to = input.to;
    if (!TASK_STATUSES.includes(to)) throw new Error('非法状态');

    if (to !== 'todo') this.cancelTaskTimer(input.taskId);
    let updated = await this.patchTask(input.taskId, { status: to, message: '' });

    if (to === 'approved' && task.status !== 'approved') {
      this.schedule(() => this.mergeTask(input.taskId));
    } else if (to === 'running') {
      const reason = await this.gitBlockReason(updated);
      if (reason) {
        updated = await this.patchTask(input.taskId, { status: 'paused', message: reason });
        return updated;
      }
      this.schedule(() => this.runTask(input.taskId));
    }
    return updated;
  }

  async approveTask(input) {
    const task = this.tasks.get(input.taskId);
    if (!task) throw new Error('任务不存在');
    if (task.status === 'done') return task;
    if (task.status !== 'review' && task.status !== 'approved') {
      throw new Error(`任务当前状态为「${STATUS_LABELS[task.status]}」，只有「待审查」或「已审核」状态可以审核`);
    }
    const updated = await this.patchTask(input.taskId, { status: 'approved', message: '等待合回基础分支…' });
    this.schedule(() => this.mergeTask(input.taskId));
    return updated;
  }

  async resumeTask(input) {
    const task = this.tasks.get(input.taskId);
    if (!task) throw new Error('任务不存在');
    if (task.status !== 'paused' && task.status !== 'todo') {
      throw new Error(`任务当前状态为「${STATUS_LABELS[task.status]}」，无需继续`);
    }
    this.cancelTaskTimer(input.taskId);
    const reason = await this.gitBlockReason(task);
    if (reason) return this.patchTask(input.taskId, { status: 'paused', message: reason });
    const updated = await this.patchTask(input.taskId, { status: 'running', message: '' });
    this.schedule(() => this.runTask(input.taskId));
    return updated;
  }

  async commentTask(input) {
    const task = this.tasks.get(input.taskId);
    if (!task) throw new Error('任务不存在');
    if (task.status !== 'review') {
      throw new Error(`任务当前状态为「${STATUS_LABELS[task.status]}」，只有「待审查」状态可以评论继续`);
    }
    const comment = (input.comment || '').trim();
    if (!comment) throw new Error('评论内容不能为空');

    const commentRecord = {
      id: randomUUID(),
      content: comment,
      createdAt: new Date().toISOString(),
    };
    const updated = await this.patchTask(input.taskId, {
      status: 'running',
      message: '已收到评论，agent 继续执行…',
      comments: [...(task.comments || []), commentRecord],
    });
    this.schedule(() => this.runContinuation(input.taskId, comment));
    return updated;
  }

  async deleteTask(input) {
    this.cancelTaskTimer(input.taskId);
    const existed = await this.tasks.delete(input.taskId);
    return { deleted: existed };
  }

  // ── scheduling (fire-and-forget, one runner per task) ─────────────────────

  schedule(fn) {
    Promise.resolve()
      .then(fn)
      .catch((err) => this.ctx.logger?.error?.('kanban background task failed: %s', err?.stack || err));
  }

  guard(taskId) {
    if (this.inFlight.has(taskId)) return false;
    this.inFlight.set(taskId, true);
    return true;
  }

  unguard(taskId) {
    this.inFlight.delete(taskId);
  }

  clearTaskTimers() {
    for (const timer of this.taskTimers.values()) clearTimeout(timer);
    this.taskTimers.clear();
  }

  cancelTaskTimer(taskId) {
    const timer = this.taskTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.taskTimers.delete(taskId);
    }
  }

  scheduleTaskTimer(taskId, executeAtMs) {
    this.cancelTaskTimer(taskId);
    const delay = Math.min(MAX_TIMEOUT_DELAY, Math.max(250, executeAtMs - Date.now()));
    const timer = setTimeout(() => {
      this.taskTimers.delete(taskId);
      const task = this.tasks.get(taskId);
      if (!task || task.status !== 'todo') return;
      const executeAt = task.executeAt ? Date.parse(task.executeAt) : 0;
      if (Number.isFinite(executeAt) && executeAt > Date.now()) {
        this.scheduleTaskTimer(taskId, executeAt);
        return;
      }
      this.schedule(() => this.runTask(taskId));
    }, delay);
    timer.unref?.();
    this.taskTimers.set(taskId, timer);
  }

  restoreScheduledTasks() {
    const now = Date.now();
    for (const task of this.listTasks()) {
      if (task.status !== 'todo' || !task.executeAt) continue;
      const executeAt = Date.parse(task.executeAt);
      if (Number.isFinite(executeAt) && executeAt > now) {
        this.scheduleTaskTimer(task.id, executeAt);
      }
    }
  }

  // ── task execution ────────────────────────────────────────────────────────

  async runTask(taskId) {
    if (!this.guard(taskId)) return;
    try {
      const task = this.tasks.get(taskId);
      if (!task) return;
      if (task.status !== 'todo' && task.status !== 'running' && task.status !== 'paused') return;

      await this.patchTask(taskId, { status: 'running', message: '' });

      const workspace = this.projectById(task.projectId);
      if (!workspace) {
        await this.patchTask(taskId, { status: 'paused', message: '项目不存在' });
        return;
      }
      const cwd = workspace.path;

      const reason = await this.gitBlockReason(task);
      if (reason) {
        await this.patchTask(taskId, { status: 'paused', message: reason });
        return;
      }

      const worktreePath = task.worktreePath || worktreePathFor(workspace, task);
      if (!task.worktreePath) {
        await this.patchTask(taskId, { worktreePath });
      }
      if (!existsSync(worktreePath)) {
        await createTaskWorktree(cwd, { ...task, worktreePath }, worktreePath);
      }

      const { sessionId, summary: agentSummary, error } = await this.spawnAgent(task, worktreePath);
      if (error) {
        await this.patchTask(taskId, { status: 'paused', message: `agent 执行失败：${error}` });
        return;
      }

      await runGit(worktreePath, ['add', '-A']);
      const commit = await runGit(worktreePath, ['commit', '-m', `${task.title} (${task.id})`]);
      if (!commit.ok && !/nothing to commit|nothing added/i.test(commit.stderr)) {
        await this.patchTask(taskId, { status: 'paused', message: `提交失败：${commit.stderr}` });
        return;
      }
      const message = commit.ok
        ? '完成，等待审查'
        : '完成（无代码变更），等待审查';
      const commitHash = commit.ok
        ? await this.gitCommitHash(worktreePath)
        : null;
      const gitSummary = commit.ok
        ? await this.gitChangeSummary(worktreePath)
        : '';
      const changeSummary = agentSummary || gitSummary || message;
      const changeLog = this.createChangeLog(
        changeSummary,
        agentSummary ? 'agent' : commit.ok ? 'git' : 'system',
        commitHash,
      );
      await this.patchTask(taskId, {
        status: 'review',
        message,
        agentSessionId: sessionId ?? null,
        changeLogs: [...(task.changeLogs || []), changeLog],
      });
    } finally {
      this.unguard(taskId);
    }
  }

  async runContinuation(taskId, comment) {
    if (!this.guard(taskId)) return;
    try {
      const task = this.tasks.get(taskId);
      if (!task) return;
      if (task.status !== 'running') return;

      const workspace = this.projectById(task.projectId);
      if (!workspace) {
        await this.patchTask(taskId, { status: 'paused', message: '项目不存在，无法继续执行' });
        return;
      }
      const cwd = workspace.path;

      const reason = await this.gitBlockReason(task);
      if (reason) {
        await this.patchTask(taskId, { status: 'paused', message: reason });
        return;
      }

      const worktreePath = task.worktreePath || worktreePathFor(workspace, task);
      if (!task.worktreePath) {
        await this.patchTask(taskId, { worktreePath });
      }
      if (!existsSync(worktreePath)) {
        await createTaskWorktree(cwd, { ...task, worktreePath }, worktreePath);
      }

      const { sessionId, summary: agentSummary, error } = await this.continueAgent(task, comment, worktreePath);
      if (error) {
        await this.patchTask(taskId, { status: 'paused', message: `agent 继续执行失败：${error}` });
        return;
      }

      await runGit(worktreePath, ['add', '-A']);
      const commit = await runGit(worktreePath, ['commit', '-m', `${task.title}（评论更新） (${task.id})`]);
      if (!commit.ok && !/nothing to commit|nothing added/i.test(commit.stderr)) {
        await this.patchTask(taskId, { status: 'paused', message: `提交失败：${commit.stderr}` });
        return;
      }

      const message = commit.ok
        ? '已根据评论继续执行，等待审查'
        : '已根据评论继续执行（无代码变更），等待审查';
      const commitHash = commit.ok
        ? await this.gitCommitHash(worktreePath)
        : null;
      const gitSummary = commit.ok
        ? await this.gitChangeSummary(worktreePath)
        : '';
      const changeSummary = agentSummary || gitSummary || message;
      const changeLog = this.createChangeLog(
        changeSummary,
        agentSummary ? 'agent' : commit.ok ? 'git' : 'system',
        commitHash,
      );
      await this.patchTask(taskId, {
        status: 'review',
        message,
        agentSessionId: sessionId ?? task.agentSessionId,
        changeLogs: [...(task.changeLogs || []), changeLog],
      });
    } finally {
      this.unguard(taskId);
    }
  }

  // ── merge + cleanup ───────────────────────────────────────────────────────

  async mergeTask(taskId) {
    if (!this.guard(taskId)) return;
    try {
      const task = this.tasks.get(taskId);
      if (!task) return;
      if (task.status !== 'approved') return;

      const workspace = this.projectById(task.projectId);
      if (!workspace) {
        await this.patchTask(taskId, { status: 'paused', message: '项目不存在，无法合回' });
        return;
      }
      const cwd = workspace.path;

      const reason = await this.gitBlockReason(task);
      if (reason) {
        await this.patchTask(taskId, { status: 'paused', message: reason });
        return;
      }

      await mergeTaskBranch(task, workspace);
      await removeTaskWorktree(cwd, task);
      const del = await runGit(cwd, ['branch', '-D', task.taskBranch]);
      const message = del.ok
        ? '已合回基础分支并删除 worktree 独立分支'
        : `已合回基础分支，但删除独立分支失败：${del.stderr}`;
      this.invalidateBranch(task.projectId);
      await this.patchTask(taskId, { status: 'done', message, worktreePath: '' });
    } finally {
      this.unguard(taskId);
    }
  }

  // ── agent execution ───────────────────────────────────────────────────────

  async spawnAgent(task, cwd, continuationComment = '') {
    const sessionId = randomUUID();
    const prompt = buildAgentPrompt(task, cwd, continuationComment);

    const selection =
      task.modelProvider && task.model
        ? { provider: task.modelProvider, model: task.model }
        : this.currentDefaultModel();

    let handle;
    try {
      handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd, agentPreset: 'standard' },
        agentOptions: selection ? { provider: selection.provider, model: selection.model } : undefined,
        setup: async (agentCtx) => {
          await this.ctx.agentPresets.mount(agentCtx, 'standard');
        },
      });
    } catch (err) {
      return { sessionId, error: `创建 agent 失败：${err?.message || err}` };
    }

    try {
      await this.attachAgentSessionToKanbanGroup(handle.agent.session.id, cwd);
      await this.setAgentSessionTitle(handle, task);
    } catch (err) {
      this.ctx.logger?.warn?.('kanban agent session metadata failed: %s', err?.stack || err);
    }

    try {
      const message = createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: 'kanban' },
      });
      handle.agent.followup(message);
      await handle.agent.whenIdle();
      return { sessionId, summary: await awaitAgentFinalOutput(handle.agent) };
    } catch (err) {
      return { sessionId, error: err?.message || String(err) };
    } finally {
      await handle.dispose().catch(() => {});
    }
  }

  async resumeAgentSession(task, selection) {
    if (!task.agentSessionId || typeof this.ctx.agents.resume !== 'function') return null;
    try {
      return await this.ctx.agents.resume({
        resumeSessionId: task.agentSessionId,
        agentOptions: selection ? { provider: selection.provider, model: selection.model } : undefined,
        setup: async (agentCtx) => {
          await this.ctx.agentPresets.mount(agentCtx, 'standard');
        },
      });
    } catch (err) {
      this.ctx.logger?.warn?.('kanban resume agent session failed: %s', err?.stack || err);
      return null;
    }
  }

  async continueAgent(task, comment, cwd) {
    const selection =
      task.modelProvider && task.model
        ? { provider: task.modelProvider, model: task.model }
        : this.currentDefaultModel();

    const handle = await this.resumeAgentSession(task, selection);
    if (!handle) {
      return this.spawnAgent(task, cwd, comment);
    }

    try {
      const startIndex = agentMessages(handle.agent).length;
      const message = createUserMessage({
        content: [{ type: 'text', text: comment }],
        source: { kind: 'plugin', plugin: 'kanban' },
      });
      handle.agent.followup(message);
      await handle.agent.whenIdle();
      return {
        sessionId: task.agentSessionId,
        summary: await awaitAgentFinalOutput(handle.agent, startIndex),
      };
    } catch (err) {
      return { sessionId: task.agentSessionId, error: err?.message || String(err) };
    } finally {
      await handle.dispose().catch(() => {});
    }
  }
}

markRemoteMethods(KanbanService, [
  'listProjects',
  'getBoard',
  'listCreateTaskOptions',
  'listBranches',
  'listProjectPaths',
  'createTask',
  'moveTask',
  'approveTask',
  'resumeTask',
  'commentTask',
  'deleteTask',
]);

export default KanbanService;
