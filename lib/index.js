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
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants, createReadStream, createWriteStream, existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Service } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import z from 'zod';
import {
  PLUGIN_VERSION,
  clearUpdateState,
  compareStableVersions,
  fetchLatestPluginRelease,
  readInstallContext,
  readUpdateState,
  resolveDshHome,
  resolveDshInvocation,
  resolveUpdateStatePath,
  writeUpdateState,
} from './update.js';

const execFileAsync = promisify(execFile);

export const TASK_STATUSES = ['todo', 'running', 'paused', 'review', 'approved', 'done'];
const KANBAN_TASK_GROUP_SUFFIX = '看板任务';
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const ATTACHMENT_ROUTE = '/kanban/attachments';
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const MAX_MESSAGE_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const KANBAN_WORKTREE_MARKER = '.kanban-worktrees';
const SNAPSHOT_WORKSPACE_DIR = 'snapshot-workspaces';
const SNAPSHOT_BACKUP_DIR = 'snapshot-backups';
const SNAPSHOT_BASE_DIR = 'base';
const SNAPSHOT_WORK_DIR = 'work';
const SNAPSHOT_MANIFEST_FILE = 'base-manifest.json';
const SNAPSHOT_CHANGESET_FILE = 'change-set.json';
const SNAPSHOT_APPLY_JOURNAL_FILE = 'apply-journal.json';
const SNAPSHOT_CONFLICT_DIR = '.kanban-conflicts';
const MAX_SNAPSHOT_FILES = 100_000;
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024 * 1024;
const SNAPSHOT_BACKUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TIMEOUT_DELAY = 2_147_483_647;
const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_AGENT_PERMISSION_PRESET = 'danger-full-access';
const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const UPDATE_RETRY_INTERVAL = 15 * 60 * 1000;
const UPDATE_STALE_TIMEOUT = 15 * 60 * 1000;
const STATUS_LABELS = {
  todo: '待领取',
  running: '执行中',
  paused: '暂停中',
  review: '待审查',
  approved: '已审核',
  done: '已完成',
};

function stripInlineImages(text) {
  if (!text) return '';
  return String(text)
    .replace(/\[[^\]]*\]\(<file:\/\/([^>]*)>(?:\s+"[^"]*")?\)/gi, '$1')
    .replace(/!\[[^\]]*\]\(data:[^)]*\)/gi, '[图片]')
    .trim();
}

function attachmentStore(ctx) {
  try {
    return typeof ctx.get === 'function' ? ctx.get('attachments') ?? ctx.attachments : ctx.attachments;
  } catch {
    return ctx.attachments;
  }
}

function attachmentRoot() {
  return join(resolveDshHome(), 'attachments', 'kanban', 'v1');
}

function attachmentObjectPath(attachmentId) {
  const match = /^sha256:([a-f0-9]{64})$/.exec(String(attachmentId || ''));
  if (!match) return null;
  return join(attachmentRoot(), 'objects', match[1].slice(0, 2), match[1]);
}

function normalizedAttachment(ref, legacyImage = false) {
  if (!ref || typeof ref !== 'object') return null;
  const mediaType = safeMediaType(ref.mediaType);
  const isImage = IMAGE_MEDIA_TYPES.includes(mediaType);
  return {
    attachmentId: String(ref.attachmentId || ''),
    kind: (ref.kind === 'image' || legacyImage) && isImage ? 'image' : 'file',
    mediaType,
    bytes: Number(ref.bytes) || 0,
    name: ref.name ? safeAttachmentName(ref.name) : undefined,
    ...(Number.isFinite(ref.width) ? { width: ref.width } : {}),
    ...(Number.isFinite(ref.height) ? { height: ref.height } : {}),
    ...(ref.imageAttachmentId
      ? { imageAttachmentId: String(ref.imageAttachmentId) }
      : legacyImage || isImage
        ? { imageAttachmentId: String(ref.attachmentId || '') }
        : {}),
  };
}

function normalizedAttachments(owner) {
  const refs = [
    ...(owner?.attachments || []).map((ref) => normalizedAttachment(ref)),
    ...(owner?.images || []).map((ref) => normalizedAttachment(ref, true)),
  ].filter((ref) => ref?.attachmentId);
  const seen = new Set();
  return refs.filter((ref) => {
    const identities = [ref.attachmentId, ref.imageAttachmentId].filter(Boolean);
    if (identities.some((identity) => seen.has(identity))) return false;
    identities.forEach((identity) => seen.add(identity));
    return true;
  });
}

function imageAttachmentRef(ref) {
  if (ref?.kind !== 'image' || !IMAGE_MEDIA_TYPES.includes(ref.mediaType)) return null;
  return {
    attachmentId: ref.imageAttachmentId || ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name ? { name: ref.name } : {}),
  };
}

async function verifiedImageAttachmentRef(ctx, attachment) {
  const store = attachmentStore(ctx);
  if (!store || typeof store.readImage !== 'function') {
    throw new Error('当前 DSH 未启用图片附件服务，无法读取任务附件');
  }

  const normalized = normalizedAttachment(attachment, true);
  const ref = imageAttachmentRef(normalized);
  if (!ref) throw new Error('图片附件引用格式不正确');

  try {
    return (await store.readImage(ref)).ref;
  } catch (error) {
    // Versions before 0.7 paired the original upload metadata with the ID of
    // DSH's normalized image. Re-saving the retained original lets DSH return
    // the complete canonical reference (including a changed media type), so
    // already-persisted tasks do not need the user to upload the image again.
    const originalPath = attachmentObjectPath(normalized.attachmentId);
    if (!originalPath || !existsSync(originalPath) || typeof store.saveImage !== 'function') throw error;
    const data = await readFile(originalPath);
    const input = { data, mediaType: normalized.mediaType, name: normalized.name };
    if (typeof store.validateImage === 'function') await store.validateImage(input);
    return store.saveImage(input);
  }
}

function headerValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function safeAttachmentName(value) {
  let decoded = String(value || 'attachment');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the raw header when it is not percent-encoded.
  }
  return basename(decoded.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240) || 'attachment';
}

function safeMediaType(value) {
  const mediaType = String(value || '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mediaType)
    ? mediaType
    : 'application/octet-stream';
}

async function saveBinaryAttachment(ctx, req) {
  const declaredLength = Number(headerValue(req.headers['content-length']) || 0);
  if (declaredLength > MAX_ATTACHMENT_BYTES) throw new Error('单个附件不能超过 50 MiB');

  const tempDir = join(attachmentRoot(), 'tmp');
  await mkdir(tempDir, { recursive: true });
  const tempPath = join(tempDir, randomUUID());
  const digest = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_ATTACHMENT_BYTES) {
        callback(new Error('单个附件不能超过 50 MiB'));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(req, meter, createWriteStream(tempPath, { flags: 'wx' }));
    if (!bytes) throw new Error('附件内容为空');
    const hash = digest.digest('hex');
    const objectPath = join(attachmentRoot(), 'objects', hash.slice(0, 2), hash);
    await mkdir(dirname(objectPath), { recursive: true });
    try {
      await rename(tempPath, objectPath);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code) || !existsSync(objectPath)) throw error;
      await rm(tempPath, { force: true });
    }

    const name = safeAttachmentName(headerValue(req.headers['x-kanban-file-name']));
    const mediaType = safeMediaType(headerValue(req.headers['content-type']));
    const base = {
      attachmentId: `sha256:${hash}`,
      kind: 'file',
      mediaType,
      bytes,
      name,
    };
    if (!IMAGE_MEDIA_TYPES.includes(mediaType)) return base;

    const store = attachmentStore(ctx);
    if (!store || typeof store.saveImage !== 'function') return base;
    const data = await readFile(objectPath);
    if (typeof store.validateImage === 'function') {
      await store.validateImage({ data, mediaType, name });
    }
    const image = await store.saveImage({ data, mediaType, name });
    return {
      attachmentId: image.attachmentId,
      kind: 'image',
      mediaType: image.mediaType,
      bytes: image.bytes,
      name: image.name,
      width: image.width,
      height: image.height,
      imageAttachmentId: image.attachmentId,
    };
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function responseJson(res, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.byteLength,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function contentDisposition(name, inline = false) {
  const ascii = safeAttachmentName(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safeAttachmentName(name))}`;
}

function byteRange(header, totalBytes) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || ''));
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start === null && end !== null) {
    start = Math.max(0, totalBytes - end);
    end = totalBytes - 1;
  } else {
    start ??= 0;
    end = Math.min(end ?? totalBytes - 1, totalBytes - 1);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= totalBytes) {
    return { invalid: true };
  }
  return { start, end };
}

function decodeImageInput(input) {
  const mediaType = String(input?.mediaType || '').toLowerCase();
  if (!IMAGE_MEDIA_TYPES.includes(mediaType)) {
    throw new Error('图片格式不受支持，仅支持 PNG、JPEG、WebP 和 GIF');
  }
  const dataBase64 = String(input?.dataBase64 || '').replace(/\s/g, '');
  const paddingIndex = dataBase64.indexOf('=');
  if (
    !dataBase64
    || dataBase64.length % 4 !== 0
    || /[^A-Za-z0-9+\/=]/.test(dataBase64)
    || (paddingIndex !== -1 && paddingIndex < dataBase64.length - 2)
  ) {
    throw new Error('图片数据格式不正确');
  }
  const data = Buffer.from(dataBase64, 'base64');
  if (!data.length) throw new Error('图片内容为空');
  const rawName = String(input?.name || 'image').replace(/\\/g, '/');
  const name = basename(rawName).slice(0, 200) || 'image';
  return { data, mediaType, name };
}

async function saveImageInputs(ctx, inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  const store = attachmentStore(ctx);
  if (!store || typeof store.saveImage !== 'function') {
    throw new Error('当前 DSH 未启用图片附件服务，无法把图片传给 Agent');
  }

  const limits = store.imageLimits || {};
  const maxImages = Number(limits.maxImagesPerMessage) || 10;
  if (inputs.length > maxImages) throw new Error('每条消息最多添加 ' + maxImages + ' 张图片');

  const decoded = inputs.map(decodeImageInput);
  const totalBytes = decoded.reduce((sum, image) => sum + image.data.byteLength, 0);
  const maxMessageBytes = Number(limits.maxMessageImageBytes) || Number.POSITIVE_INFINITY;
  if (totalBytes > maxMessageBytes) throw new Error('图片总大小超过 DSH 限制');

  if (typeof store.validateImage === 'function') {
    await Promise.all(decoded.map((image) => store.validateImage(image)));
  }
  return Promise.all(decoded.map((image) => store.saveImage(image)));
}

async function imageContentBlocks(ctx, images) {
  const seen = new Set();
  const blocks = [];
  for (const attachment of images || []) {
    const candidate = imageAttachmentRef(normalizedAttachment(attachment, true));
    const id = String(candidate?.attachmentId || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const image = await verifiedImageAttachmentRef(ctx, attachment);
    blocks.push({ type: 'image', attachment: image });
  }
  return blocks;
}

function attachmentContext(files) {
  if (!files.length) return '';
  return [
    '任务附件（已保存到工作目录内，可直接读取）：',
    ...files.map((file) => `- ${file.name}：${file.path}（${file.mediaType}，${file.bytes} bytes）`),
  ].join('\n');
}

function primaryAgentSessionId(task) {
  if (task?.agentSessionId) return task.agentSessionId;
  const sessionIds = task?.agentSessionIds || [];
  return sessionIds.at(-1) || null;
}

async function ensureAttachmentExclude(cwd) {
  const gitPath = await runGit(cwd, ['rev-parse', '--git-path', 'info/exclude']);
  if (!gitPath.ok || !gitPath.stdout) return;
  const excludePath = isAbsolute(gitPath.stdout) ? gitPath.stdout : resolve(cwd, gitPath.stdout);
  await mkdir(dirname(excludePath), { recursive: true });
  const current = await readFile(excludePath, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  const pattern = '.kanban-attachments/';
  if (current.split(/\r?\n/).includes(pattern)) return;
  await writeFile(excludePath, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${pattern}\n`);
}

async function materializeFileAttachments(task, cwd, extraAttachments = []) {
  const attachments = [
    ...normalizedAttachments(task),
    ...extraAttachments.map((ref) => normalizedAttachment(ref)).filter(Boolean),
  ].filter((ref) => ref.kind !== 'image');
  if (!attachments.length) return [];

  await ensureAttachmentExclude(cwd);
  const targetDir = join(cwd, '.kanban-attachments');
  await mkdir(targetDir, { recursive: true });
  const seen = new Set();
  const files = [];
  for (const attachment of attachments) {
    if (seen.has(attachment.attachmentId)) continue;
    seen.add(attachment.attachmentId);
    const source = attachmentObjectPath(attachment.attachmentId);
    if (!source || !existsSync(source)) continue;
    const digest = attachment.attachmentId.replace(/^sha256:/, '').slice(0, 12);
    const name = safeAttachmentName(attachment.name || 'attachment');
    const target = join(targetDir, `${digest}-${name}`);
    await copyFile(source, target);
    files.push({
      name,
      path: target,
      mediaType: attachment.mediaType,
      bytes: attachment.bytes,
    });
  }
  return files;
}

function buildAgentPrompt(task, cwd, continuationComment = '', attachmentFiles = []) {
  const fileContext = attachmentContext(attachmentFiles);
  const snapshotMode = taskExecutionMode(task) === 'snapshot';
  const prompt = [
    snapshotMode
      ? '你是一个在隔离文件快照中执行开发任务的编程 agent。'
      : '你是一个在独立 git 分支上执行开发任务的编程 agent。',
    '',
    `任务标题：${task.title}`,
    `任务描述：${stripInlineImages(task.description) || '（无）'}`,
    ...(fileContext ? ['', fileContext] : []),
    '',
    `你当前的工作目录是：${cwd}`,
    snapshotMode
      ? '系统已创建项目的隔离副本。请只修改当前工作目录，不要修改原项目目录或工作目录外的文件。'
      : `系统已经为你切好了独立分支 ${task.taskBranch}，请直接在这个目录中完成开发。`,
    '',
    '要求：',
    '- 直接修改工作目录中的代码文件，完成任务。',
    ...(snapshotMode
      ? ['- 当前项目不使用 Git 交付；系统会计算文件变更并在人工审核后应用到原项目。']
      : [
        '- 不要执行 git commit / git checkout / git merge 等分支管理操作（系统会统一提交）。',
        '- 可以用 git status / git diff 查看改动，但不要提交。',
      ]),
    '- 完成后简要说明你做了什么改动。',
  ].join('\n');

  const comment = stripInlineImages(continuationComment);
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

async function waitForAgentIdle(agent, timeoutMs) {
  const idle = Promise.resolve().then(() => agent.whenIdle());
  while (true) {
    let timer;
    const outcome = await Promise.race([
      idle.then(() => 'idle'),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });

    if (outcome === 'idle') return;
    // A long-running turn is healthy. Treat the timeout as a heartbeat interval
    // and extend it while the Agent still reports that it is actively running.
    if (agent?.status === 'running') continue;
    throw new Error('agent 执行超时，请稍后重试');
  }
}

function activeAgentTurnFirstSeq(agent) {
  try {
    const events = agent?.session?.events;
    if (!Array.isArray(events)) return agent?.session?.seq ?? 0;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type === 'turn/end') break;
      if (event?.type === 'turn/start') return event.seq ?? 0;
    }
    return agent?.session?.seq ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Read the terminal outcome for the agent turn started after `firstSeq`.
 *
 * Agent.whenIdle() only waits for quiescence. Runtime/model failures are
 * persisted as turn/end events instead of being rejected through that promise,
 * so callers must inspect the owned session interval before treating a turn as
 * successful.
 */
function agentTurnFailure(agent, firstSeq = 0) {
  try {
    const events = agent?.session?.events;
    if (!Array.isArray(events)) return '';

    let started = false;
    let reason;
    for (const event of events) {
      if (!event || (typeof event.seq === 'number' && event.seq < firstSeq)) continue;
      if (event.type === 'turn/start') {
        started = true;
        continue;
      }
      if (started && event.type === 'turn/end') reason = event.data?.reason;
    }

    if (!reason || reason.kind === 'completed') return '';
    if (reason.kind === 'error') {
      return reason.error?.message || reason.error?.code || 'agent 执行失败';
    }
    if (reason.kind === 'blocked') return 'agent 执行被运行时阻止';
    if (reason.kind === 'aborted') return `agent 执行已中止（${reason.reason?.kind || 'unknown'}）`;
    if (reason.kind === 'max-tokens') return 'agent 达到最大输出 token 限制';
    if (reason.kind === 'interrupted') return 'agent 会话意外中断';
    return `agent 未正常完成（${reason.kind || 'unknown'}）`;
  } catch {
    return '';
  }
}

// ── storage domain ──────────────────────────────────────────────────────────

const imageAttachmentSchema = z.object({
  attachmentId: z.string(),
  mediaType: z.enum(IMAGE_MEDIA_TYPES),
  bytes: z.number(),
  width: z.number(),
  height: z.number(),
  name: z.string().optional(),
});

const attachmentSchema = z.object({
  attachmentId: z.string(),
  kind: z.enum(['image', 'file']).default('file'),
  mediaType: z.string(),
  bytes: z.number(),
  name: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  imageAttachmentId: z.string().optional(),
});

const taskCommentSchema = z.object({
  id: z.string(),
  content: z.string(),
  createdAt: z.string(),
  attachments: z.array(attachmentSchema).default([]),
  images: z.array(imageAttachmentSchema).default([]),
});

const taskChangeLogSchema = z.object({
  id: z.string(),
  summary: z.string(),
  source: z.enum(['agent', 'git', 'snapshot', 'system']).default('agent'),
  commit: z.string().nullable().default(null),
  createdAt: z.string(),
});

const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  description: z.string(),
  attachments: z.array(attachmentSchema).default([]),
  images: z.array(imageAttachmentSchema).default([]),
  baseBranch: z.string(),
  taskBranch: z.string(),
  worktreePath: z.string().default(''),
  executionMode: z.enum(['git-worktree', 'snapshot']).default('git-worktree'),
  workspacePath: z.string().default(''),
  baseRevision: z.string().nullable().default(null),
  changeSetId: z.string().nullable().default(null),
  backupId: z.string().nullable().default(null),
  changeStats: z.object({
    added: z.number(),
    modified: z.number(),
    deleted: z.number(),
  }).nullable().default(null),
  status: z.enum(TASK_STATUSES),
  message: z.string(),
  agentSessionId: z.string().nullable(),
  agentSessionIds: z.array(z.string()).default([]),
  modelProvider: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  executeAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  comments: z.array(taskCommentSchema).default([]),
  changeLogs: z.array(taskChangeLogSchema).default([]),
  mergeConflictFiles: z.array(z.string()).default([]),
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

let gitAvailabilityPromise;
function isGitCliAvailable() {
  gitAvailabilityPromise ??= execFileAsync('git', ['--version'], { timeout: 10000 })
    .then(() => true, () => false);
  return gitAvailabilityPromise;
}

function hasGitMetadata(cwd) {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, '.git'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

  // ── project path listing (for "@" file references in description/comment) ─

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

const SNAPSHOT_SKIP_ENTRIES = new Set([
  ...PATH_SCAN_SKIP_DIRS,
  '.kanban-attachments',
  SNAPSHOT_CONFLICT_DIR,
]);

function snapshotTaskRoot(taskId) {
  return join(resolveDshHome(), 'kanban', SNAPSHOT_WORKSPACE_DIR, taskId);
}

function snapshotBackupRoot(taskId, backupId) {
  return join(resolveDshHome(), 'kanban', SNAPSHOT_BACKUP_DIR, taskId, backupId);
}

function pathIsWithin(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function safeRelativePath(root, relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`不安全的快照路径：${relativePath}`);
  }
  const target = resolve(root, normalized);
  if (!pathIsWithin(root, target)) throw new Error(`快照路径超出项目目录：${relativePath}`);
  return target;
}

async function assertNoSymlinkAncestors(root, relativePath, nonDirectoryIsMissing = false) {
  const segments = String(relativePath || '').replace(/\\/g, '/').split('/').slice(0, -1);
  let current = resolve(root);
  for (const segment of segments) {
    current = join(current, segment);
    const info = await lstat(current).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) return true;
    if (info.isSymbolicLink()) throw new Error(`拒绝通过符号链接目录访问快照路径：${relativePath}`);
    if (!info.isDirectory()) {
      if (nonDirectoryIsMissing) return false;
      throw new Error(`快照路径的父级不是目录：${relativePath}`);
    }
  }
  return true;
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function copyFileClone(source, target, mode) {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target, fsConstants.COPYFILE_FICLONE);
  if (Number.isInteger(mode)) await chmod(target, mode & 0o777);
}

async function copySnapshotTree(
  sourceRoot,
  targetRoot,
  currentDir = sourceRoot,
  budget = { files: 0, bytes: 0 },
) {
  await mkdir(targetRoot, { recursive: true });
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (SNAPSHOT_SKIP_ENTRIES.has(entry.name)) continue;
    const source = join(currentDir, entry.name);
    if (pathIsWithin(source, targetRoot)) continue;
    const rel = relative(sourceRoot, source);
    const target = safeRelativePath(targetRoot, rel);
    if (entry.isDirectory()) {
      await mkdir(target, { recursive: true });
      await copySnapshotTree(sourceRoot, targetRoot, source, budget);
      continue;
    }
    if (entry.isFile()) {
      const info = await lstat(source);
      budget.files += 1;
      budget.bytes += info.size;
      if (budget.files > MAX_SNAPSHOT_FILES || budget.bytes > MAX_SNAPSHOT_BYTES) {
        throw new Error('项目快照超过限制（最多 100000 个文件、5 GiB），请排除生成物或改用 Git 模式');
      }
      await copyFileClone(source, target, info.mode);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    const linkTarget = await readlink(source);
    if (isAbsolute(linkTarget) || !pathIsWithin(sourceRoot, resolve(dirname(source), linkTarget))) continue;
    await mkdir(dirname(target), { recursive: true });
    await symlink(linkTarget, target);
  }
}

async function hashFile(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

async function snapshotEntryAt(root, relativePath) {
  const path = safeRelativePath(root, relativePath);
  if (!await assertNoSymlinkAncestors(root, relativePath, true)) return null;
  const info = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!info) return null;
  if (info.isFile()) {
    return {
      path: relativePath,
      type: 'file',
      size: info.size,
      mode: info.mode & 0o777,
      hash: await hashFile(path),
    };
  }
  if (info.isSymbolicLink()) {
    const target = await readlink(path);
    if (isAbsolute(target) || !pathIsWithin(root, resolve(dirname(path), target))) {
      throw new Error(`快照中存在指向项目外部的符号链接：${relativePath}`);
    }
    return { path: relativePath, type: 'symlink', target };
  }
  return null;
}

async function buildSnapshotManifest(root) {
  const entries = [];
  let totalBytes = 0;
  async function walk(dir) {
    const children = await readdir(dir, { withFileTypes: true });
    for (const child of children) {
      if (SNAPSHOT_SKIP_ENTRIES.has(child.name)) continue;
      const path = join(dir, child.name);
      const rel = relative(root, path).replace(/\\/g, '/');
      if (child.isDirectory()) {
        await walk(path);
        continue;
      }
      const entry = await snapshotEntryAt(root, rel);
      if (entry) {
        entries.push(entry);
        totalBytes += entry.size || 0;
        if (entries.length > MAX_SNAPSHOT_FILES || totalBytes > MAX_SNAPSHOT_BYTES) {
          throw new Error('工作副本超过限制（最多 100000 个文件、5 GiB）');
        }
      }
    }
  }
  await walk(root);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

function snapshotEntryEquals(left, right) {
  if (!left || !right) return left === right;
  if (left.type !== right.type) return false;
  if (left.type === 'symlink') return left.target === right.target;
  return left.hash === right.hash && left.mode === right.mode;
}

function snapshotManifestMap(entries) {
  return new Map((entries || []).map((entry) => [entry.path, entry]));
}

function buildSnapshotChangeSet(baseEntries, workEntries) {
  const base = snapshotManifestMap(baseEntries);
  const work = snapshotManifestMap(workEntries);
  const paths = [...new Set([...base.keys(), ...work.keys()])].sort((a, b) => a.localeCompare(b));
  const added = [];
  const modified = [];
  const deleted = [];
  for (const path of paths) {
    const before = base.get(path) || null;
    const after = work.get(path) || null;
    if (!before && after) added.push(path);
    else if (before && !after) deleted.push(path);
    else if (!snapshotEntryEquals(before, after)) modified.push(path);
  }
  return { added, modified, deleted };
}

function snapshotChangeStats(changeSet) {
  return {
    added: changeSet.added.length,
    modified: changeSet.modified.length,
    deleted: changeSet.deleted.length,
  };
}

function snapshotChangeSummary(changeSet) {
  const stats = snapshotChangeStats(changeSet);
  const parts = [];
  if (stats.added) parts.push(`新增 ${stats.added} 个文件`);
  if (stats.modified) parts.push(`修改 ${stats.modified} 个文件`);
  if (stats.deleted) parts.push(`删除 ${stats.deleted} 个文件`);
  return parts.length ? parts.join('，') : '未检测到文件变更';
}

async function createSnapshotWorkspace(workspace, task) {
  const root = snapshotTaskRoot(task.id);
  const basePath = join(root, SNAPSHOT_BASE_DIR);
  const workPath = join(root, SNAPSHOT_WORK_DIR);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await copySnapshotTree(workspace.path, basePath);
  await copySnapshotTree(basePath, workPath);
  const entries = await buildSnapshotManifest(basePath);
  const revision = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  await writeJsonAtomic(join(root, SNAPSHOT_MANIFEST_FILE), { revision, entries });
  return { workspacePath: workPath, baseRevision: `snapshot:${revision}` };
}

async function readSnapshotState(task) {
  const root = snapshotTaskRoot(task.id);
  const manifest = JSON.parse(await readFile(join(root, SNAPSHOT_MANIFEST_FILE), 'utf8'));
  return {
    root,
    basePath: join(root, SNAPSHOT_BASE_DIR),
    workPath: join(root, SNAPSHOT_WORK_DIR),
    manifest,
  };
}

async function verifySnapshotBase(task, state) {
  const entries = await buildSnapshotManifest(state.basePath);
  const revision = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  if (
    revision !== state.manifest.revision
    || (task.baseRevision && task.baseRevision !== `snapshot:${revision}`)
  ) {
    throw new Error('任务基线快照已被修改，无法安全生成或应用变更');
  }
}

async function collectSnapshotChanges(task) {
  const state = await readSnapshotState(task);
  await verifySnapshotBase(task, state);
  const workEntries = await buildSnapshotManifest(state.workPath);
  const changeSet = buildSnapshotChangeSet(state.manifest.entries, workEntries);
  const id = createHash('sha256').update(JSON.stringify(changeSet)).digest('hex');
  await writeJsonAtomic(join(state.root, SNAPSHOT_CHANGESET_FILE), { id, ...changeSet });
  return { id, changeSet, stats: snapshotChangeStats(changeSet) };
}

async function copySnapshotEntry(sourceRoot, targetRoot, relativePath, expectedEntry = null) {
  const source = safeRelativePath(sourceRoot, relativePath);
  const target = safeRelativePath(targetRoot, relativePath);
  await assertNoSymlinkAncestors(sourceRoot, relativePath);
  await assertNoSymlinkAncestors(targetRoot, relativePath);
  const entry = expectedEntry || await snapshotEntryAt(sourceRoot, relativePath);
  if (!entry) throw new Error(`快照文件不存在：${relativePath}`);
  await mkdir(dirname(target), { recursive: true });
  const tempPath = join(dirname(target), `.${basename(target)}.kanban-${randomUUID()}.tmp`);
  if (entry.type === 'symlink') {
    if (isAbsolute(entry.target) || !pathIsWithin(targetRoot, resolve(dirname(target), entry.target))) {
      throw new Error(`拒绝应用指向项目外部的符号链接：${relativePath}`);
    }
    try {
      await symlink(entry.target, tempPath);
      await rm(target, { recursive: true, force: true });
      await rename(tempPath, target);
      return;
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }
  try {
    await copyFileClone(source, tempPath, entry.mode);
    await rm(target, { recursive: true, force: true });
    await rename(tempPath, target);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function restoreSnapshotBackup(projectRoot, backupRoot, records) {
  const deepestFirst = [...records].sort((a, b) => b.path.split('/').length - a.path.split('/').length);
  for (const record of deepestFirst) {
    const target = safeRelativePath(projectRoot, record.path);
    await rm(target, { recursive: true, force: true }).catch((error) => {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    });
  }
  const shallowestFirst = records
    .filter((record) => record.entry)
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  for (const record of shallowestFirst) {
    await copySnapshotEntry(join(backupRoot, 'files'), projectRoot, record.path, record.entry);
  }
}

class SnapshotConflictError extends Error {
  constructor(files) {
    super(`快照应用冲突：${files.join('、')}`);
    this.name = 'SnapshotConflictError';
    this.files = files;
  }
}

function snapshotConflictMessage(files) {
  const list = files.length
    ? files.map((file) => `- \`${file}\``).join('\n')
    : '- （未识别到具体文件）';
  return '任务执行期间原项目中的相关文件也发生了变化，已停止应用，原项目没有被覆盖。'
    + `\n\n冲突文件：\n${list}`
    + '\n\n点击“让 Agent 解决冲突”，Agent 会在隔离副本中参考最新文件重新处理。';
}

async function findAppliedSnapshotBackup(taskId, changeSetId) {
  const taskRoot = join(resolveDshHome(), 'kanban', SNAPSHOT_BACKUP_DIR, taskId);
  const backups = await readdir(taskRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  for (const backup of backups.sort((a, b) => b.name.localeCompare(a.name))) {
    if (!backup.isDirectory()) continue;
    const journal = await readFile(join(taskRoot, backup.name, SNAPSHOT_APPLY_JOURNAL_FILE), 'utf8')
      .then((value) => JSON.parse(value), () => null);
    if (journal?.status === 'applied' && journal.changeSetId === changeSetId) return backup.name;
  }
  return null;
}

async function applySnapshotChanges(task, workspace) {
  const state = await readSnapshotState(task);
  await verifySnapshotBase(task, state);
  const persisted = JSON.parse(await readFile(join(state.root, SNAPSHOT_CHANGESET_FILE), 'utf8'));
  if (!task.changeSetId || persisted.id !== task.changeSetId) {
    throw new Error('待审核的文件变更集已丢失或不匹配，请让 Agent 重新执行');
  }
  const alreadyAppliedBackupId = await findAppliedSnapshotBackup(task.id, persisted.id);
  if (alreadyAppliedBackupId) return { backupId: alreadyAppliedBackupId };

  const paths = [...persisted.added, ...persisted.modified, ...persisted.deleted];
  if (!paths.length) return { backupId: null };
  const base = snapshotManifestMap(state.manifest.entries);
  const conflicts = [];
  const currentEntries = new Map();
  for (const path of paths) {
    const current = await snapshotEntryAt(workspace.path, path);
    currentEntries.set(path, current);
    if (!snapshotEntryEquals(base.get(path) || null, current)) conflicts.push(path);
  }
  if (conflicts.length) throw new SnapshotConflictError(conflicts);

  const backupId = `${Date.now()}-${randomUUID()}`;
  const backupRoot = snapshotBackupRoot(task.id, backupId);
  const records = paths.map((path) => ({ path, entry: currentEntries.get(path) || null }));
  await mkdir(join(backupRoot, 'files'), { recursive: true });
  for (const record of records) {
    if (record.entry) {
      await copySnapshotEntry(workspace.path, join(backupRoot, 'files'), record.path, record.entry);
    }
  }
  const changedDuringBackup = [];
  for (const record of records) {
    const current = await snapshotEntryAt(workspace.path, record.path);
    if (!snapshotEntryEquals(record.entry, current)) changedDuringBackup.push(record.path);
  }
  if (changedDuringBackup.length) {
    await rm(backupRoot, { recursive: true, force: true });
    throw new SnapshotConflictError(changedDuringBackup);
  }
  const journalPath = join(backupRoot, SNAPSHOT_APPLY_JOURNAL_FILE);
  await writeJsonAtomic(journalPath, {
    taskId: task.id,
    changeSetId: persisted.id,
    status: 'applying',
    createdAt: new Date().toISOString(),
    records,
  });

  try {
    const work = snapshotManifestMap(await buildSnapshotManifest(state.workPath));
    const assertStillCurrent = async (path) => {
      const current = await snapshotEntryAt(workspace.path, path);
      if (!snapshotEntryEquals(base.get(path) || null, current)) {
        throw new SnapshotConflictError([path]);
      }
    };
    const deletions = [...persisted.deleted]
      .sort((a, b) => b.split('/').length - a.split('/').length);
    for (const path of deletions) {
      await assertStillCurrent(path);
      await rm(safeRelativePath(workspace.path, path), { recursive: true, force: true });
    }
    const writes = [...persisted.added, ...persisted.modified]
      .sort((a, b) => a.split('/').length - b.split('/').length);
    for (const path of writes) {
      await assertStillCurrent(path);
      await copySnapshotEntry(state.workPath, workspace.path, path, work.get(path));
    }
    await writeJsonAtomic(journalPath, {
      taskId: task.id,
      changeSetId: persisted.id,
      status: 'applied',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      records,
    });
  } catch (error) {
    try {
      await restoreSnapshotBackup(workspace.path, backupRoot, records);
      await writeJsonAtomic(journalPath, {
        taskId: task.id,
        changeSetId: persisted.id,
        status: 'rolled-back',
        createdAt: new Date().toISOString(),
        rolledBackAt: new Date().toISOString(),
        error: error?.message || String(error),
        records,
      });
    } catch (rollbackError) {
      throw new Error(`应用快照失败且自动恢复失败：${error?.message || error}；${rollbackError?.message || rollbackError}`);
    }
    throw error;
  }
  return { backupId };
}

async function cleanupExpiredSnapshotBackups(now = Date.now()) {
  const root = join(resolveDshHome(), 'kanban', SNAPSHOT_BACKUP_DIR);
  const taskDirs = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  for (const taskDir of taskDirs) {
    if (!taskDir.isDirectory()) continue;
    const taskRoot = join(root, taskDir.name);
    const backups = await readdir(taskRoot, { withFileTypes: true });
    for (const backup of backups) {
      if (!backup.isDirectory()) continue;
      const createdAt = Number(backup.name.split('-', 1)[0]);
      const backupRoot = join(taskRoot, backup.name);
      const journal = await readFile(join(backupRoot, SNAPSHOT_APPLY_JOURNAL_FILE), 'utf8')
        .then((value) => JSON.parse(value), () => null);
      if (
        journal?.status !== 'applying'
        && Number.isFinite(createdAt)
        && now - createdAt > SNAPSHOT_BACKUP_RETENTION_MS
      ) {
        await rm(backupRoot, { recursive: true, force: true });
      }
    }
    const remaining = await readdir(taskRoot);
    if (!remaining.length) await rm(taskRoot, { recursive: true, force: true });
  }
}

async function listPendingSnapshotApplyJournals() {
  const root = join(resolveDshHome(), 'kanban', SNAPSHOT_BACKUP_DIR);
  const pending = [];
  const taskDirs = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  for (const taskDir of taskDirs) {
    if (!taskDir.isDirectory()) continue;
    const taskRoot = join(root, taskDir.name);
    const backups = await readdir(taskRoot, { withFileTypes: true });
    for (const backup of backups) {
      if (!backup.isDirectory()) continue;
      const backupRoot = join(taskRoot, backup.name);
      const journalPath = join(backupRoot, SNAPSHOT_APPLY_JOURNAL_FILE);
      const journal = await readFile(journalPath, 'utf8')
        .then((value) => JSON.parse(value), () => null);
      if (journal?.status === 'applying' && Array.isArray(journal.records)) {
        pending.push({ backupRoot, journalPath, journal });
      }
    }
  }
  return pending;
}

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
        count += 1;
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

async function mergeInProgress(cwd) {
  const r = await runGit(cwd, ['rev-parse', '--verify', '-q', 'MERGE_HEAD']);
  return r.ok && Boolean(r.stdout);
}

async function listUnmergedFiles(cwd) {
  const r = await runGit(cwd, ['diff', '--name-only', '--diff-filter=U']);
  if (!r.ok || !r.stdout) return [];
  return r.stdout.split('\n').map((file) => file.trim()).filter(Boolean);
}

async function abortMerge(cwd) {
  if (!await mergeInProgress(cwd)) return;
  const abort = await runGit(cwd, ['merge', '--abort']);
  if (!abort.ok) {
    throw new Error('回滚失败：' + (abort.stderr || abort.stdout || 'git merge --abort 执行失败'));
  }
}

class MergeConflictError extends Error {
  constructor(files) {
    super('合并冲突：' + files.join('、'));
    this.name = 'MergeConflictError';
    this.files = files;
  }
}

function mergeConflictMessage(files, prefix = '合回基础分支时发生冲突') {
  const list = files.length
    ? files.map((file) => '- `' + file + '`').join('\n')
    : '- （未识别到具体文件）';
  return prefix + '，已安全回滚，主仓库未保留半合并状态。\n\n冲突文件：\n' + list
    + '\n\n点击“让 Agent 解决冲突”，处理后会重新进入待审查。';
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

async function deleteTaskGitResources(workspace, task) {
  const cwd = workspace.path;
  const worktreePath = task.worktreePath || worktreePathFor(workspace, task);

  if (existsSync(worktreePath)) {
    const removed = await runGit(cwd, ['worktree', 'remove', '--force', worktreePath]);
    await rm(worktreePath, { recursive: true, force: true });
    if (!removed.ok) await runGit(cwd, ['worktree', 'prune']);
  } else {
    await runGit(cwd, ['worktree', 'prune']);
  }

  if (!task.taskBranch) return;
  if (task.taskBranch === task.baseBranch) {
    throw new Error('任务分支与基础分支相同，已拒绝删除分支');
  }

  const listed = await runGit(cwd, ['branch', '--list', task.taskBranch]);
  if (!listed.ok) throw new Error(listed.stderr || listed.stdout || '检查任务分支失败');
  if (!listed.stdout) return;

  const deleted = await runGit(cwd, ['branch', '-D', task.taskBranch]);
  if (!deleted.ok) throw new Error(deleted.stderr || deleted.stdout || '删除任务分支失败');
}

async function mergeTaskBranch(task, workspace) {
  const cwd = workspace.path;
  const current = await currentBranch(cwd);
  const message = `Merge kanban task ${task.id}: ${task.title}`;

  if (current === task.baseBranch) {
    if (await mergeInProgress(cwd)) throw new Error('主仓库已有未完成的合并，请先处理后重试');
    const merge = await runGit(cwd, ['merge', '--no-ff', '--autostash', task.taskBranch, '-m', message]);
    if (!merge.ok) {
      const conflicts = await listUnmergedFiles(cwd);
      await abortMerge(cwd);
      if (conflicts.length) throw new MergeConflictError(conflicts);
      throw new Error(merge.stderr || merge.stdout || '合并失败');
    }
    return;
  }

  const tempPath = join(worktreeRoot(workspace), `merge-${task.id}`);
  await mkdir(dirname(tempPath), { recursive: true });
  const add = await runGit(cwd, ['worktree', 'add', '-f', '--detach', tempPath, task.baseBranch]);
  if (!add.ok) throw new Error(add.stderr || add.stdout || '创建合并 worktree 失败');

  try {
    const merge = await runGit(tempPath, ['merge', '--no-ff', task.taskBranch, '-m', message]);
    if (!merge.ok) {
      const conflicts = await listUnmergedFiles(tempPath);
      await abortMerge(tempPath);
      if (conflicts.length) throw new MergeConflictError(conflicts);
      throw new Error(merge.stderr || merge.stdout || '合并失败');
    }
    const head = await runGit(tempPath, ['rev-parse', 'HEAD']);
    if (!head.ok) throw new Error(head.stderr || head.stdout || '读取合并提交失败');
    const update = await runGit(cwd, ['update-ref', `refs/heads/${task.baseBranch}`, head.stdout]);
    if (!update.ok) throw new Error(update.stderr || update.stdout || '更新目标分支失败');
  } finally {
    await runGit(cwd, ['worktree', 'remove', '--force', tempPath]);
    await rm(tempPath, { recursive: true, force: true });
  }
}

function taskExecutionMode(task) {
  if (task.executionMode === 'snapshot') return 'snapshot';
  if (task.executionMode === 'git-worktree' && task.taskBranch) return 'git-worktree';
  return task.taskBranch ? 'git-worktree' : 'snapshot';
}

function taskWorkspacePath(task) {
  return task.workspacePath || task.worktreePath || '';
}

class GitWorkspaceDriver {
  kind = 'git-worktree';

  async validate(task, workspace) {
    if (!workspace) return '项目不存在';
    if (!await isGitRepository(workspace.path)) return '项目不是可用的 git 仓库';
    if (!await hasCommits(workspace.path)) return '仓库还没有任何 commit，无法签出分支';
    if (!task.baseBranch || !task.taskBranch) return '任务缺少 git 分支信息，无法执行';
    return null;
  }

  async prepare(service, task, workspace) {
    const path = taskWorkspacePath(task) || worktreePathFor(workspace, task);
    if (!taskWorkspacePath(task)) {
      await service.patchTask(task.id, { workspacePath: path, worktreePath: path });
    }
    if (!existsSync(path)) await createTaskWorktree(workspace.path, { ...task, worktreePath: path }, path);
    return path;
  }

  async collect(service, task, workspacePath, continuation = false) {
    const add = await runGit(workspacePath, ['add', '-A']);
    if (!add.ok) throw new Error(`暂存失败：${add.stderr || add.stdout}`);
    const suffix = continuation ? '（评论更新）' : '';
    const commit = await runGit(workspacePath, ['commit', '-m', `${task.title}${suffix} (${task.id})`]);
    if (!commit.ok && !/nothing to commit|nothing added/i.test(commit.stderr)) {
      throw new Error(`提交失败：${commit.stderr || commit.stdout}`);
    }
    const committed = commit.ok;
    return {
      message: committed
        ? continuation ? '已根据评论继续执行，等待审查' : '完成，等待审查'
        : continuation ? '已根据评论继续执行（无代码变更），等待审查' : '完成（无代码变更），等待审查',
      commit: committed ? await service.gitCommitHash(workspacePath) : null,
      summary: committed ? await service.gitChangeSummary(workspacePath) : '',
      source: committed ? 'git' : 'system',
      changeSetId: null,
      changeStats: null,
    };
  }

  async deliver(_service, task, workspace) {
    await mergeTaskBranch(task, workspace);
    const warnings = [];
    try {
      await removeTaskWorktree(workspace.path, task);
    } catch (error) {
      warnings.push(`删除 worktree 失败：${error?.message || error}`);
    }
    const deleted = await runGit(workspace.path, ['branch', '-D', task.taskBranch]);
    if (!deleted.ok) warnings.push(`删除独立分支失败：${deleted.stderr || deleted.stdout}`);
    return {
      message: warnings.length
        ? `已合回基础分支；${warnings.join('；')}`
        : '已合回基础分支并删除 worktree 独立分支',
      backupId: null,
    };
  }

  cleanup(_service, task, workspace) {
    return deleteTaskGitResources(workspace, task);
  }
}

class SnapshotWorkspaceDriver {
  kind = 'snapshot';

  async validate(_task, workspace) {
    if (!workspace) return '项目不存在';
    const info = await stat(workspace.path).catch(() => null);
    return info?.isDirectory() ? null : '项目目录不存在或不可访问';
  }

  async prepare(service, task, workspace) {
    const existingPath = taskWorkspacePath(task);
    if (task.baseRevision || existingPath) {
      const path = existingPath || join(snapshotTaskRoot(task.id), SNAPSHOT_WORK_DIR);
      const manifestPath = join(snapshotTaskRoot(task.id), SNAPSHOT_MANIFEST_FILE);
      if (!existsSync(path) || !existsSync(manifestPath)) {
        throw new Error('任务的快照工作区已丢失，无法安全恢复；请删除任务后重新创建');
      }
      if (!task.workspacePath) await service.patchTask(task.id, { workspacePath: path });
      return path;
    }
    const created = await createSnapshotWorkspace(workspace, task);
    await service.patchTask(task.id, {
      workspacePath: created.workspacePath,
      baseRevision: created.baseRevision,
    });
    return created.workspacePath;
  }

  async collect(_service, task, _workspacePath, continuation = false) {
    const collected = await collectSnapshotChanges(task);
    const summary = snapshotChangeSummary(collected.changeSet);
    const changed = collected.stats.added + collected.stats.modified + collected.stats.deleted > 0;
    return {
      message: changed
        ? continuation ? `已根据评论继续执行，${summary}，等待审查` : `${summary}，等待审查`
        : continuation ? '已根据评论继续执行（无文件变更），等待审查' : '完成（无文件变更），等待审查',
      commit: null,
      summary: changed ? summary : '',
      source: changed ? 'snapshot' : 'system',
      changeSetId: collected.id,
      changeStats: collected.stats,
    };
  }

  async deliver(_service, task, workspace) {
    const result = await applySnapshotChanges(task, workspace);
    return {
      message: result.backupId
        ? `已将文件变更安全应用到项目；恢复备份将在 7 天后清理：${result.backupId}`
        : '任务没有文件变更，无需应用到项目',
      backupId: result.backupId,
    };
  }

  async cleanup(_service, task) {
    await rm(snapshotTaskRoot(task.id), { recursive: true, force: true });
  }
}

const WORKSPACE_DRIVERS = {
  'git-worktree': new GitWorkspaceDriver(),
  snapshot: new SnapshotWorkspaceDriver(),
};

function workspaceDriverForTask(task) {
  return WORKSPACE_DRIVERS[taskExecutionMode(task)];
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
    'permissionPresets',
    'agentDefaultModel',
    'llm',
  ];

  constructor(ctx) {
    super(ctx, 'kanban');
    this.domain = null;
    this.tasks = null;
    this.branchCache = new Map();
    this.inFlight = new Map();
    this.inFlightWaiters = new Map();
    this.activeTaskAgents = new Map();
    this.deletingTasks = new Set();
    this.taskTimers = new Map();
    this.projectDeliveryLocks = new Map();
    this.agentTimeoutMs = DEFAULT_AGENT_TIMEOUT_MS;
    this.updateCache = null;
    this.ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'prefix',
        path: ATTACHMENT_ROUTE,
        handler: (req, res) => this.handleAttachmentRequest(req, res),
      }), 'kanban.attachmentRoute');
    });
  }

  async [Service.init]() {
    this.domain = await this.ctx.storageDomain.open(kanbanDomain);
    this.tasks = this.domain.table('tasks');
    this.ctx.effect(() => () => this.domain.close(), 'kanban.domainClose');
    this.ctx.effect(() => () => this.clearTaskTimers(), 'kanban.taskTimers');
    await this.cleanupKanbanTaskWorkspaces();
    await this.recoverInterruptedSnapshotApplies();
    await cleanupExpiredSnapshotBackups().catch((error) => {
      this.ctx.logger?.warn?.('kanban snapshot backup cleanup failed: %s', error?.stack || error);
    });
    await this.restoreRunningTasks();
    this.restoreScheduledTasks();
    this.restoreApprovedTasks();
  }

  // ── internal helpers ──────────────────────────────────────────────────────

  async recoverInterruptedSnapshotApplies() {
    const pending = await listPendingSnapshotApplyJournals().catch((error) => {
      this.ctx.logger?.warn?.('kanban snapshot journal scan failed: %s', error?.stack || error);
      return [];
    });
    for (const item of pending) {
      const task = this.tasks.get(item.journal.taskId);
      const workspace = task ? this.projectById(task.projectId) : null;
      if (!task || !workspace) {
        this.ctx.logger?.warn?.(
          'kanban cannot recover interrupted snapshot apply for task %s: project or task missing',
          item.journal.taskId,
        );
        continue;
      }
      try {
        await restoreSnapshotBackup(workspace.path, item.backupRoot, item.journal.records);
        await writeJsonAtomic(item.journalPath, {
          ...item.journal,
          status: 'rolled-back',
          recoveredAt: new Date().toISOString(),
        });
        await this.patchTask(task.id, {
          status: 'paused',
          message: '检测到上次快照应用被中断，已从备份恢复原项目；请检查后重新审核',
        });
      } catch (error) {
        this.ctx.logger?.error?.(
          'kanban interrupted snapshot apply recovery failed: %s',
          error?.stack || error,
        );
        await this.patchTask(task.id, {
          status: 'paused',
          message: `上次快照应用被中断且自动恢复失败：${error?.message || error}`,
        });
      }
    }
  }

  taskAttachment(task, attachmentId) {
    return [
      ...normalizedAttachments(task),
      ...(task?.comments || []).flatMap((comment) => normalizedAttachments(comment)),
    ].find((attachment) => attachment.attachmentId === attachmentId) || null;
  }

  async validateAttachmentRefs(refs) {
    if (!Array.isArray(refs) || refs.length === 0) return [];
    if (refs.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new Error(`每条消息最多添加 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`);
    }

    const normalized = refs.map((ref) => normalizedAttachment(ref)).filter(Boolean);
    if (normalized.length !== refs.length) throw new Error('附件引用格式不正确');
    const totalBytes = normalized.reduce((sum, ref) => sum + ref.bytes, 0);
    if (totalBytes > MAX_MESSAGE_ATTACHMENT_BYTES) throw new Error('附件总大小不能超过 100 MiB');

    return Promise.all(normalized.map(async (ref) => {
      if (ref.kind === 'image') {
        const image = await verifiedImageAttachmentRef(this.ctx, ref);
        return normalizedAttachment({ ...image, kind: 'image' }, true);
      }
      const objectPath = attachmentObjectPath(ref.attachmentId);
      if (objectPath) {
        const info = await stat(objectPath).catch(() => null);
        if (info?.isFile() && info.size === ref.bytes) return ref;
      }
      throw new Error(`附件“${ref.name || ref.attachmentId}”不存在或已损坏`);
    }));
  }

  async handleAttachmentRequest(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === ATTACHMENT_ROUTE) {
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' });
        res.end();
        return;
      }
      try {
        const attachment = await saveBinaryAttachment(this.ctx, req);
        responseJson(res, 201, attachment);
      } catch (error) {
        responseJson(res, 400, { error: error?.message || String(error) });
      }
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    let attachmentId;
    try {
      attachmentId = decodeURIComponent(url.pathname.slice(ATTACHMENT_ROUTE.length + 1));
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const task = this.tasks?.get(url.searchParams.get('taskId') || '');
    const attachment = task ? this.taskAttachment(task, attachmentId) : null;
    if (!attachment) {
      res.writeHead(404);
      res.end();
      return;
    }

    const commonHeaders = {
      'Content-Type': attachment.mediaType,
      'Content-Disposition': contentDisposition(
        attachment.name || 'attachment',
        attachment.kind === 'image' && IMAGE_MEDIA_TYPES.includes(attachment.mediaType),
      ),
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: `"${attachment.attachmentId}"`,
    };
    const range = byteRange(headerValue(req.headers.range), attachment.bytes);
    if (range?.invalid) {
      res.writeHead(416, { ...commonHeaders, 'Content-Range': `bytes */${attachment.bytes}` });
      res.end();
      return;
    }

    const objectPath = attachmentObjectPath(attachment.attachmentId);
    const objectInfo = objectPath ? await stat(objectPath).catch(() => null) : null;
    if (objectPath && objectInfo?.isFile()) {
      const start = range?.start ?? 0;
      const end = range?.end ?? objectInfo.size - 1;
      res.writeHead(range ? 206 : 200, {
        ...commonHeaders,
        'Content-Length': end - start + 1,
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${objectInfo.size}` } : {}),
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      await pipeline(createReadStream(objectPath, { start, end }), res);
      return;
    }

    const store = attachmentStore(this.ctx);
    const imageRef = imageAttachmentRef(attachment);
    if (!imageRef || !store || typeof store.readImage !== 'function') {
      res.writeHead(404);
      res.end();
      return;
    }
    const stored = await store.readImage(imageRef);
    const data = Buffer.from(stored.data);
    const start = range?.start ?? 0;
    const end = range?.end ?? data.byteLength - 1;
    res.writeHead(range ? 206 : 200, {
      ...commonHeaders,
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${data.byteLength}` } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : data.subarray(start, end + 1));
  }

  async latestPluginRelease(force = false) {
    const now = Date.now();
    if (!force && this.updateCache && this.updateCache.expiresAt > now) return this.updateCache;
    try {
      const release = await fetchLatestPluginRelease();
      this.updateCache = {
        release,
        error: null,
        checkedAt: new Date().toISOString(),
        expiresAt: now + UPDATE_CHECK_INTERVAL,
      };
    } catch (error) {
      this.updateCache = {
        release: null,
        error: error?.message || String(error),
        checkedAt: new Date().toISOString(),
        expiresAt: now + UPDATE_RETRY_INTERVAL,
      };
    }
    return this.updateCache;
  }

  async normalizedPluginUpdateState() {
    const statePath = resolveUpdateStatePath();
    const state = await readUpdateState(statePath);
    if (!state) return null;

    if (state.targetVersion === PLUGIN_VERSION && ['restarting', 'succeeded'].includes(state.status)) {
      const completed = {
        ...state,
        status: 'succeeded',
        installedVersion: PLUGIN_VERSION,
        requiresRestart: false,
        message: `任务看板已更新到 ${PLUGIN_VERSION}`,
        finishedAt: state.finishedAt || new Date().toISOString(),
      };
      await writeUpdateState(completed, statePath);
      return completed;
    }

    const startedAt = Date.parse(state.startedAt || '');
    if (
      ['installing', 'restarting'].includes(state.status)
      && Number.isFinite(startedAt)
      && Date.now() - startedAt > UPDATE_STALE_TIMEOUT
    ) {
      const failed = {
        ...state,
        status: 'failed',
        message: state.status === 'restarting' ? 'DSH 重启超时，新版本尚未生效。' : '插件更新进程超时。',
        finishedAt: new Date().toISOString(),
      };
      await writeUpdateState(failed, statePath);
      return failed;
    }
    return state;
  }

  async getPluginUpdateInfo() {
    const install = await readInstallContext();
    const state = await this.normalizedPluginUpdateState();
    let release = null;
    let checkError = null;

    if (install.enabled) {
      const cached = await this.latestPluginRelease();
      checkError = cached.error;
      if (cached.release && compareStableVersions(cached.release.version, PLUGIN_VERSION) > 0) {
        release = cached.release;
      }
    }

    return {
      currentVersion: PLUGIN_VERSION,
      enabled: install.enabled,
      disabledReason: install.disabledReason,
      installedSpec: install.installedSpec,
      checkedAt: this.updateCache?.checkedAt ?? null,
      checkError,
      update: release,
      state,
    };
  }

  async startPluginUpdate(input) {
    const install = await readInstallContext();
    if (!install.enabled) {
      const message = install.disabledReason === 'development-install'
        ? '当前是 file/link 本地开发安装，为避免覆盖源码，已禁用一键更新。'
        : '当前插件安装来源不支持一键更新。';
      throw new Error(message);
    }

    const existing = await this.normalizedPluginUpdateState();
    if (existing && ['installing', 'restarting'].includes(existing.status)) return existing;

    const cached = await this.latestPluginRelease();
    if (cached.error) throw new Error(cached.error);
    const release = cached.release;
    if (!release || compareStableVersions(release.version, PLUGIN_VERSION) <= 0) {
      throw new Error('当前已经是最新版本。');
    }
    if (!input || input.tag !== release.tagName) throw new Error('目标版本不是当前最新的稳定 Release。');

    const invocation = resolveDshInvocation();
    const updaterPath = fileURLToPath(new URL('./updater.js', import.meta.url));
    if (!invocation || !existsSync(updaterPath)) {
      throw new Error('找不到 DSH 或插件更新器入口。');
    }

    const statePath = resolveUpdateStatePath();
    const state = {
      status: 'installing',
      targetVersion: release.version,
      tagName: release.tagName,
      message: `正在下载并安装 ${release.tagName}…`,
      startedAt: new Date().toISOString(),
    };
    await writeUpdateState(state, statePath);

    const child = spawn(process.execPath, [
      updaterPath,
      '--tag', release.tagName,
      '--state', statePath,
      '--dsh', invocation.command,
      '--dshArgs', JSON.stringify(invocation.prefixArgs),
      '--dshEnv', JSON.stringify(invocation.env),
      '--profile', install.profileName,
      '--profileDir', install.profileDir,
      '--restartService', `dsh-${install.profileName}.service`,
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      // 桌面宿主的 process.execPath 是 Electron 主程序：不置 ELECTRON_RUN_AS_NODE
      // 会拉起一个真正的 Electron 应用而不是执行 updater.js。
      env: process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : { ...process.env },
    });
    child.once('error', (error) => {
      void writeUpdateState({
        ...state,
        status: 'failed',
        message: `无法启动更新器：${error?.message || String(error)}`,
        finishedAt: new Date().toISOString(),
      }, statePath);
    });
    child.unref();
    return state;
  }

  async acknowledgePluginUpdate(input) {
    const state = await this.normalizedPluginUpdateState();
    if (!state || state.targetVersion !== input?.targetVersion) return { cleared: false };
    if (!['succeeded', 'failed'].includes(state.status)) return { cleared: false };
    await clearUpdateState();
    return { cleared: true };
  }

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
    if (!title.endsWith(KANBAN_TASK_GROUP_SUFFIX)) return false;
    return path.split(/[\\/]/).some((segment) => segment.endsWith(KANBAN_WORKTREE_MARKER));
  }

  kanbanTaskIdFromWorkspace(workspace) {
    if (!this.isKanbanTaskWorkspace(workspace)) return null;
    const segments = (workspace.path || '').split(/[\\/]/).filter(Boolean);
    const markerIndex = segments.findIndex((segment) => segment.endsWith(KANBAN_WORKTREE_MARKER));
    return markerIndex >= 0 ? segments[markerIndex + 1] || null : null;
  }

  async deleteKanbanTaskWorkspaces(taskId) {
    const registry = this.ctx.workspaceRegistry;
    if (typeof registry?.delete !== 'function') return;
    const matches = registry.list().filter(
      (workspace) => this.kanbanTaskIdFromWorkspace(workspace) === taskId,
    );
    await Promise.all(matches.map(async (workspace) => {
      try {
        await registry.delete(workspace.id);
      } catch (err) {
        this.ctx.logger?.warn?.(
          'kanban task workspace cleanup failed: %s',
          err?.stack || err,
        );
      }
    }));
  }

  async cleanupKanbanTaskWorkspaces() {
    const registry = this.ctx.workspaceRegistry;
    if (typeof registry?.delete !== 'function') return;
    const legacy = registry.list().filter((workspace) => this.isKanbanTaskWorkspace(workspace));
    await Promise.all(legacy.map(async (workspace) => {
      const taskId = this.kanbanTaskIdFromWorkspace(workspace);
      const task = taskId ? this.tasks.get(taskId) : null;
      if (task) {
        const agentSessionIds = [...new Set([
          ...(task.agentSessionIds || []),
          ...(task.agentSessionId ? [task.agentSessionId] : []),
          ...(workspace.sessionIds || []),
        ])];
        const agentSessionId = task.agentSessionId
          || task.agentSessionIds?.at(-1)
          || workspace.sessionIds?.[0]
          || null;
        await this.tasks.put(task.id, { ...task, agentSessionId, agentSessionIds });
      }
      try {
        await registry.delete(workspace.id);
      } catch (err) {
        this.ctx.logger?.warn?.(
          'kanban legacy task workspace cleanup failed: %s',
          err?.stack || err,
        );
      }
    }));
  }

  async recordAgentSession(taskId, sessionId) {
    const task = this.tasks.get(taskId);
    if (!task || !sessionId) return;
    const agentSessionId = primaryAgentSessionId(task) || sessionId;
    if (agentSessionId !== sessionId) {
      throw new Error(`任务已经绑定 Agent 会话 ${agentSessionId}，不能切换到新会话 ${sessionId}`);
    }
    const agentSessionIds = [...new Set([
      ...(task.agentSessionIds || []),
      ...(task.agentSessionId ? [task.agentSessionId] : []),
      sessionId,
    ])];
    await this.patchTask(taskId, { agentSessionId, agentSessionIds });
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
    const [gitCliAvailable, git] = await Promise.all([
      isGitCliAvailable(),
      isGitRepository(workspace.path),
    ]);
    const committed = git ? await hasCommits(workspace.path) : false;
    const branch = git ? await currentBranch(workspace.path) : '';
    return {
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      branch,
      git,
      gitCliAvailable,
      sourceControl: git || hasGitMetadata(workspace.path) ? 'git' : 'none',
      executionMode: git && committed ? 'git-worktree' : 'snapshot',
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
   * for "@" file references in task descriptions / comments.
   * Prefers `git ls-files` (fast, respects .gitignore); falls back to a
   * bounded directory walk for non-git projects.
   */
  async listProjectPaths(input) {
    const workspace = this.projectById(input.projectId);
    if (!workspace) return { paths: [] };
    // 整体超时保护：git 命令或目录扫描异常时返回空列表，避免远程调用卡死。
    const timeout = new Promise((resolve) => {
      setTimeout(() => resolve({ paths: [] }), 15000);
    });
    const result = await Promise.race([this.collectProjectPaths(workspace.path), timeout]);
    return result;
  }

  async collectProjectPaths(cwd) {
    let files = [];
    if (await isGitRepository(cwd)) {
      const r = await runGit(cwd, [
        'ls-files', '--cached', '--others', '--exclude-standard',
      ]);
      if (r.ok) {
        files = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      }
    }
    if (!files.length) {
      files = await scanProjectPaths(cwd);
    }

    const set = new Set(files.map((p) => p.replace(/\\/g, '/')));
    for (const dir of deriveParentDirs(set)) set.add(dir);
    return { paths: [...set].sort((a, b) => a.localeCompare(b)) };
  }

  invalidateBranch(projectId) {
    this.branchCache.delete(projectId);
  }

  async workspaceBlockReason(task) {
    const workspace = this.projectById(task.projectId);
    return workspaceDriverForTask(task).validate(task, workspace);
  }

  listTasks() {
    return [...this.tasks.entries()]
      .map(([, t]) => {
        const attachments = normalizedAttachments(t);
        return {
          ...t,
          executionMode: taskExecutionMode(t),
          workspacePath: t.workspacePath || t.worktreePath || '',
          baseRevision: t.baseRevision ?? null,
          changeSetId: t.changeSetId ?? null,
          backupId: t.backupId ?? null,
          changeStats: t.changeStats ?? null,
          attachments,
          images: attachments.map(imageAttachmentRef).filter(Boolean),
          agentSessionIds: t.agentSessionIds ?? [],
          comments: (t.comments ?? []).map((comment) => {
            const commentAttachments = normalizedAttachments(comment);
            return {
              ...comment,
              attachments: commentAttachments,
              images: commentAttachments.map(imageAttachmentRef).filter(Boolean),
            };
          }),
          changeLogs: t.changeLogs ?? [],
          mergeConflictFiles: t.mergeConflictFiles ?? [],
        };
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  listTaskSessions() {
    const sessionIds = new Set();
    for (const task of this.listTasks()) {
      if (task.agentSessionId) sessionIds.add(task.agentSessionId);
      for (const sessionId of task.agentSessionIds || []) sessionIds.add(sessionId);
    }
    return { sessionIds: [...sessionIds] };
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
    const projectVersion = projects
      .map((p) => `${p.branch}:${p.sourceControl}:${p.executionMode}:${p.gitCliAvailable ? 1 : 0}`)
      .join('|');
    return {
      projects,
      tasks,
      statuses: TASK_STATUSES.map((s) => ({ id: s, label: STATUS_LABELS[s] })),
      version: `${projectVersion}|${taskVersion}`,
    };
  }

  async getTaskImage(input) {
    const task = this.tasks.get(input?.taskId);
    if (!task) throw new Error('任务不存在');

    const attachmentId = String(input?.attachmentId || '');
    const image = this.taskAttachment(task, attachmentId);
    if (!image) throw new Error('任务附件不存在');

    const objectPath = attachmentObjectPath(image.attachmentId);
    if (objectPath && existsSync(objectPath)) {
      return {
        attachmentId: image.attachmentId,
        mediaType: image.mediaType,
        name: image.name,
        dataBase64: (await readFile(objectPath)).toString('base64'),
      };
    }

    const store = attachmentStore(this.ctx);
    if (!store || typeof store.readImage !== 'function') {
      throw new Error('当前 DSH 未启用图片附件服务，无法读取任务附件');
    }
    const stored = await store.readImage(await verifiedImageAttachmentRef(this.ctx, image));
    return {
      attachmentId: stored.ref.attachmentId,
      mediaType: stored.ref.mediaType,
      name: stored.ref.name,
      dataBase64: Buffer.from(stored.data).toString('base64'),
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
    const executionMode = project.executionMode;
    const waiting = Boolean(executeAt && Date.parse(executeAt) > Date.now());
    const [uploadedAttachments, legacyImages] = await Promise.all([
      this.validateAttachmentRefs(input.attachments),
      saveImageInputs(this.ctx, input.images),
    ]);
    const attachments = [
      ...uploadedAttachments,
      ...legacyImages.map((image) => normalizedAttachment(image, true)),
    ];

    const id = randomUUID();
    const now = new Date().toISOString();
    const task = {
      id,
      projectId: input.projectId,
      title,
      description: (input.description || '').trim(),
      attachments,
      images: attachments.map(imageAttachmentRef).filter(Boolean),
      baseBranch,
      taskBranch: executionMode === 'git-worktree' ? `kanban/${id.slice(0, 8)}` : '',
      worktreePath: '',
      executionMode,
      workspacePath: '',
      baseRevision: null,
      changeSetId: null,
      backupId: null,
      changeStats: null,
      status: 'todo',
      message: waiting
          ? `等待执行时间：${new Date(executeAt).toLocaleString('zh-CN', { hour12: false })}`
          : '',
      agentSessionId: null,
      agentSessionIds: [],
      modelProvider,
      model,
      executeAt,
      createdAt: now,
      updatedAt: now,
      comments: [],
      changeLogs: [],
      mergeConflictFiles: [],
    };

    await this.tasks.put(id, task);
    if (waiting) {
      this.scheduleTaskTimer(id, Date.parse(executeAt));
    } else {
      this.schedule(() => this.runTask(id));
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
      const reason = await this.workspaceBlockReason(updated);
      if (reason) {
        updated = await this.patchTask(input.taskId, { status: 'paused', message: reason });
        return updated;
      }
      if ((task.mergeConflictFiles || []).length) {
        updated = await this.patchTask(input.taskId, {
          message: taskExecutionMode(task) === 'snapshot'
            ? 'Agent 正在根据原项目的最新文件解决快照冲突…'
            : 'Agent 正在解决与基础分支的合并冲突…',
        });
        this.schedule(() => taskExecutionMode(task) === 'snapshot'
          ? this.resolveSnapshotConflicts(input.taskId)
          : this.resolveMergeConflicts(input.taskId));
      } else {
        this.schedule(() => this.runTask(input.taskId));
      }
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
    const updated = await this.patchTask(input.taskId, {
      status: 'approved',
      message: taskExecutionMode(task) === 'snapshot' ? '等待将文件变更应用到项目…' : '等待合回基础分支…',
    });
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
    const reason = await this.workspaceBlockReason(task);
    if (reason) return this.patchTask(input.taskId, { status: 'paused', message: reason });
    const resolvingConflicts = (task.mergeConflictFiles || []).length > 0;
    const updated = await this.patchTask(input.taskId, {
      status: 'running',
      message: resolvingConflicts
        ? taskExecutionMode(task) === 'snapshot'
          ? 'Agent 正在根据原项目的最新文件解决快照冲突…'
          : 'Agent 正在解决与基础分支的合并冲突…'
        : '',
    });
    this.schedule(() => resolvingConflicts
      ? taskExecutionMode(task) === 'snapshot'
        ? this.resolveSnapshotConflicts(input.taskId)
        : this.resolveMergeConflicts(input.taskId)
      : this.runTask(input.taskId));
    return updated;
  }

  async commentTask(input) {
    const task = this.tasks.get(input.taskId);
    if (!task) throw new Error('任务不存在');
    if (task.status !== 'review') {
      throw new Error(`任务当前状态为「${STATUS_LABELS[task.status]}」，只有「待审查」状态可以评论继续`);
    }
    const comment = (input.comment || '').trim();
    const imageInputs = Array.isArray(input.images) ? input.images : [];
    const attachmentInputs = Array.isArray(input.attachments) ? input.attachments : [];
    if (!comment && imageInputs.length === 0 && attachmentInputs.length === 0) {
      throw new Error('评论内容不能为空');
    }
    const [uploadedAttachments, legacyImages] = await Promise.all([
      this.validateAttachmentRefs(attachmentInputs),
      saveImageInputs(this.ctx, imageInputs),
    ]);
    const attachments = [
      ...uploadedAttachments,
      ...legacyImages.map((image) => normalizedAttachment(image, true)),
    ];

    const commentRecord = {
      id: randomUUID(),
      content: comment,
      createdAt: new Date().toISOString(),
      attachments,
      images: attachments.map(imageAttachmentRef).filter(Boolean),
    };
    const updated = await this.patchTask(input.taskId, {
      status: 'running',
      message: '已收到评论，agent 继续执行…',
      comments: [...(task.comments || []), commentRecord],
    });
    this.schedule(() => this.runContinuation(input.taskId, comment, attachments));
    return updated;
  }

  async deleteTask(input) {
    const taskId = input.taskId;
    const initialTask = this.tasks.get(taskId);
    if (!initialTask) return { deleted: false };
    if (initialTask.status === 'running') throw new Error('执行中的任务不可删除');
    if (initialTask.status === 'done') throw new Error('已完成的任务不可删除');

    this.deletingTasks.add(taskId);
    this.cancelTaskTimer(taskId);
    try {
      if (initialTask.status === 'running' || this.activeTaskAgents.has(taskId)) {
        await this.terminateTaskAgents(initialTask);
      }
      await this.waitForTaskIdle(taskId);

      const task = this.tasks.get(taskId) || initialTask;
      if (task.status === 'running') throw new Error('执行中的任务不可删除');
      if (task.status === 'done') throw new Error('已完成的任务不可删除');
      if (task.taskBranch || taskWorkspacePath(task) || taskExecutionMode(task) === 'snapshot') {
        const workspace = this.projectById(task.projectId);
        if (!workspace) throw new Error('项目不存在，无法清理任务工作区');
        await workspaceDriverForTask(task).cleanup(this, task, workspace);
        this.invalidateBranch(task.projectId);
      }

      const existed = await this.tasks.delete(taskId);
      if (existed) await this.deleteKanbanTaskWorkspaces(taskId);
      return { deleted: existed };
    } finally {
      this.deletingTasks.delete(taskId);
    }
  }

  // ── scheduling (fire-and-forget, one runner per task) ─────────────────────

  schedule(fn) {
    Promise.resolve()
      .then(fn)
      .catch((err) => this.ctx.logger?.error?.('kanban background task failed: %s', err?.stack || err));
  }

  guard(taskId) {
    if (this.deletingTasks.has(taskId) || this.inFlight.has(taskId)) return false;
    this.inFlight.set(taskId, true);
    return true;
  }

  unguard(taskId) {
    this.inFlight.delete(taskId);
    const waiters = this.inFlightWaiters.get(taskId);
    if (!waiters) return;
    this.inFlightWaiters.delete(taskId);
    for (const resolve of waiters) resolve();
  }

  waitForTaskIdle(taskId) {
    if (!this.inFlight.has(taskId)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.inFlightWaiters.get(taskId) || new Set();
      waiters.add(resolve);
      this.inFlightWaiters.set(taskId, waiters);
    });
  }

  async withProjectDeliveryLock(projectId, operation) {
    const previous = this.projectDeliveryLocks.get(projectId) || Promise.resolve();
    let release;
    const gate = new Promise((resolveGate) => { release = resolveGate; });
    const queued = previous.catch(() => {}).then(() => gate);
    this.projectDeliveryLocks.set(projectId, queued);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.projectDeliveryLocks.get(projectId) === queued) this.projectDeliveryLocks.delete(projectId);
    }
  }

  trackTaskAgent(taskId, agent) {
    const agents = this.activeTaskAgents.get(taskId) || new Set();
    agents.add(agent);
    this.activeTaskAgents.set(taskId, agents);
    if (this.deletingTasks.has(taskId)) agent.cancel?.({ kind: 'user' });
    return () => {
      agents.delete(agent);
      if (!agents.size) this.activeTaskAgents.delete(taskId);
    };
  }

  async terminateTaskAgents(task) {
    const agents = new Set(this.activeTaskAgents.get(task.id) || []);
    if (typeof this.ctx.agents.get === 'function') {
      const sessionIds = new Set([
        task.agentSessionId,
        ...(task.agentSessionIds || []),
      ].filter(Boolean));
      for (const sessionId of sessionIds) {
        const agent = this.ctx.agents.get(sessionId);
        if (agent?.status === 'running') agents.add(agent);
      }
    }

    for (const agent of agents) agent.cancel?.({ kind: 'user' });
    await Promise.all([...agents].map((agent) => agent.whenIdle?.()));
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
      if (!Number.isFinite(executeAt)) continue;
      if (executeAt > now) {
        this.scheduleTaskTimer(task.id, executeAt);
      } else {
        this.schedule(() => this.runTask(task.id));
      }
    }
  }

  async restoreRunningTasks() {
    for (const task of this.listTasks()) {
      if (task.status !== 'running') continue;
      await this.patchTask(task.id, {
        status: 'paused',
        message: 'DSH 服务已重启，原 agent 执行已中断，请点击“继续执行”重试',
      });
    }
  }

  restoreApprovedTasks() {
    for (const task of this.listTasks()) {
      if (task.status !== 'approved') continue;
      this.schedule(() => this.mergeTask(task.id));
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
      const driver = workspaceDriverForTask(task);
      const reason = await driver.validate(task, workspace);
      if (reason) {
        await this.patchTask(taskId, { status: 'paused', message: reason });
        return;
      }
      const executionPath = await driver.prepare(this, task, workspace);

      const existingSessionId = primaryAgentSessionId(task);
      const execution = existingSessionId
        ? this.continueAgent(
          { ...task, agentSessionId: existingSessionId },
          '请从上次暂停或中断的位置继续执行当前任务。先检查工作目录中的现有改动，再完成剩余工作。',
          executionPath,
        )
        : this.spawnAgent(task, executionPath);
      const { sessionId, summary: agentSummary, error } = await execution;
      if (error) {
        await this.patchTask(taskId, { status: 'paused', message: `agent 执行失败：${error}` });
        return;
      }

      const collected = await driver.collect(this, task, executionPath, false);
      const changeSummary = agentSummary || collected.summary || collected.message;
      const changeLog = this.createChangeLog(
        changeSummary,
        agentSummary ? 'agent' : collected.source,
        collected.commit,
      );
      await this.patchTask(taskId, {
        status: 'review',
        message: collected.message,
        agentSessionId: sessionId ?? null,
        changeSetId: collected.changeSetId,
        changeStats: collected.changeStats,
        changeLogs: [...(task.changeLogs || []), changeLog],
      });
    } catch (err) {
      await this.patchTask(taskId, {
        status: 'paused',
        message: `任务执行异常：${err?.message || err}`,
      });
    } finally {
      this.unguard(taskId);
    }
  }

  async runContinuation(taskId, comment, images = []) {
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
      const driver = workspaceDriverForTask(task);
      const reason = await driver.validate(task, workspace);
      if (reason) {
        await this.patchTask(taskId, { status: 'paused', message: reason });
        return;
      }
      const executionPath = await driver.prepare(this, task, workspace);

      const { sessionId, summary: agentSummary, error } = await this.continueAgent(task, comment, executionPath, images);
      if (error) {
        await this.patchTask(taskId, { status: 'paused', message: `agent 继续执行失败：${error}` });
        return;
      }

      const collected = await driver.collect(this, task, executionPath, true);
      const changeSummary = agentSummary || collected.summary || collected.message;
      const changeLog = this.createChangeLog(
        changeSummary,
        agentSummary ? 'agent' : collected.source,
        collected.commit,
      );
      await this.patchTask(taskId, {
        status: 'review',
        message: collected.message,
        agentSessionId: sessionId ?? task.agentSessionId,
        changeSetId: collected.changeSetId,
        changeStats: collected.changeStats,
        changeLogs: [...(task.changeLogs || []), changeLog],
      });
    } catch (err) {
      await this.patchTask(taskId, {
        status: 'paused',
        message: `任务继续执行异常：${err?.message || err}`,
      });
    } finally {
      this.unguard(taskId);
    }
  }

  async resolveSnapshotConflicts(taskId) {
    if (!this.guard(taskId)) return;
    let conflictRoot = '';
    try {
      const task = this.tasks.get(taskId);
      if (!task || task.status !== 'running' || taskExecutionMode(task) !== 'snapshot') return;
      const workspace = this.projectById(task.projectId);
      if (!workspace) {
        await this.patchTask(taskId, { status: 'paused', message: '项目不存在，无法解决快照冲突' });
        return;
      }
      const files = [...new Set(task.mergeConflictFiles || [])];
      if (!files.length) {
        await this.patchTask(taskId, { status: 'paused', message: '没有可处理的快照冲突文件' });
        return;
      }

      const state = await readSnapshotState(task);
      conflictRoot = join(state.workPath, SNAPSHOT_CONFLICT_DIR);
      const baseMirror = join(conflictRoot, 'base');
      const currentMirror = join(conflictRoot, 'current');
      await rm(conflictRoot, { recursive: true, force: true });
      await mkdir(baseMirror, { recursive: true });
      await mkdir(currentMirror, { recursive: true });

      const baseEntries = snapshotManifestMap(state.manifest.entries);
      const currentEntries = new Map();
      for (const path of files) {
        const baseEntry = baseEntries.get(path) || null;
        const currentEntry = await snapshotEntryAt(workspace.path, path);
        currentEntries.set(path, currentEntry);
        if (baseEntry) await copySnapshotEntry(state.basePath, baseMirror, path, baseEntry);
        if (currentEntry) await copySnapshotEntry(workspace.path, currentMirror, path, currentEntry);
      }
      await writeJsonAtomic(join(conflictRoot, 'context.json'), {
        files,
        missingInBase: files.filter((path) => !baseEntries.get(path)),
        missingInCurrent: files.filter((path) => !currentEntries.get(path)),
      });

      const prompt = [
        '原项目中的部分文件在任务执行期间也发生了变化。系统已把冲突内容复制到当前隔离工作区。',
        `任务开始时的版本：${baseMirror}`,
        `原项目当前版本：${currentMirror}`,
        `你的任务版本：${state.workPath}`,
        '',
        '请比较三个版本，并只修改“你的任务版本”中的实际项目文件以解决冲突：',
        ...files.map((file) => `- ${file}`),
        '',
        `缺失文件信息记录在 ${join(conflictRoot, 'context.json')}。`,
        '不要修改原项目目录，不要修改 .kanban-conflicts，也不要执行 Git 分支或提交操作。',
        '完成后简要说明每个冲突文件的取舍。',
      ].join('\n');
      const { sessionId, summary: agentSummary, error } = await this.continueAgent(
        task,
        prompt,
        state.workPath,
      );
      if (error) {
        await this.patchTask(taskId, {
          status: 'paused',
          message: `Agent 解决快照冲突失败：${error}`,
        });
        return;
      }

      const changedAgain = [];
      for (const path of files) {
        const current = await snapshotEntryAt(workspace.path, path);
        if (!snapshotEntryEquals(currentEntries.get(path) || null, current)) changedAgain.push(path);
      }
      if (changedAgain.length) throw new SnapshotConflictError(changedAgain);

      const deepestFirst = [...files].sort((a, b) => b.split('/').length - a.split('/').length);
      for (const path of deepestFirst) {
        await rm(safeRelativePath(state.basePath, path), { recursive: true, force: true })
          .catch((error) => {
            if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
          });
      }
      const currentFiles = files
        .filter((path) => currentEntries.get(path))
        .sort((a, b) => a.split('/').length - b.split('/').length);
      for (const path of currentFiles) {
        await copySnapshotEntry(currentMirror, state.basePath, path, currentEntries.get(path));
      }
      const entries = await buildSnapshotManifest(state.basePath);
      const revision = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
      await writeJsonAtomic(join(state.root, SNAPSHOT_MANIFEST_FILE), { revision, entries });
      await rm(conflictRoot, { recursive: true, force: true });
      conflictRoot = '';

      const collected = await collectSnapshotChanges({
        ...task,
        baseRevision: `snapshot:${revision}`,
      });
      const summary = agentSummary || snapshotChangeSummary(collected.changeSet);
      const changeLog = this.createChangeLog(summary, agentSummary ? 'agent' : 'snapshot', null);
      await this.patchTask(taskId, {
        status: 'review',
        message: '快照冲突已解决，等待重新审查',
        agentSessionId: sessionId ?? task.agentSessionId,
        baseRevision: `snapshot:${revision}`,
        changeSetId: collected.id,
        changeStats: collected.stats,
        mergeConflictFiles: [],
        changeLogs: [...(task.changeLogs || []), changeLog],
      });
    } catch (error) {
      const task = this.tasks.get(taskId);
      if (task) {
        await this.patchTask(taskId, {
          status: 'paused',
          message: error instanceof SnapshotConflictError
            ? snapshotConflictMessage(error.files)
            : `快照冲突恢复失败：${error?.message || error}`,
          ...(error instanceof SnapshotConflictError ? { mergeConflictFiles: error.files } : {}),
        });
      }
    } finally {
      if (conflictRoot) await rm(conflictRoot, { recursive: true, force: true }).catch(() => {});
      this.unguard(taskId);
    }
  }

  async resolveMergeConflicts(taskId) {
    if (!this.guard(taskId)) return;
    let worktreePath = '';
    try {
      const task = this.tasks.get(taskId);
      if (!task || task.status !== 'running') return;

      const workspace = this.projectById(task.projectId);
      if (!workspace) {
        await this.patchTask(taskId, { status: 'paused', message: '项目不存在，无法解决合并冲突' });
        return;
      }
      const cwd = workspace.path;
      const reason = await this.workspaceBlockReason(task);
      if (reason) {
        await this.patchTask(taskId, { status: 'paused', message: reason });
        return;
      }

      worktreePath = task.worktreePath || worktreePathFor(workspace, task);
      if (!task.worktreePath) await this.patchTask(taskId, { worktreePath });
      if (!existsSync(worktreePath)) {
        await createTaskWorktree(cwd, { ...task, worktreePath }, worktreePath);
      }

      // This worktree is owned by the task. A previous interrupted resolution
      // can therefore be rolled back safely before starting a fresh attempt.
      await abortMerge(worktreePath);
      if (await hasUncommitted(worktreePath)) {
        await this.patchTask(taskId, {
          status: 'paused',
          message: '任务 worktree 中还有未提交改动，无法安全开始冲突处理',
        });
        return;
      }

      const mergeMessage = `Merge ${task.baseBranch} into ${task.taskBranch} for conflict resolution`;
      const merge = await runGit(worktreePath, [
        'merge', '--no-ff', task.baseBranch, '-m', mergeMessage,
      ]);

      if (merge.ok) {
        const commitHash = await this.gitCommitHash(worktreePath);
        const changeLog = this.createChangeLog(
          `已同步基础分支 ${task.baseBranch}，当前不再存在合并冲突。`,
          'git',
          commitHash,
        );
        await this.patchTask(taskId, {
          status: 'review',
          message: '已同步最新基础分支，等待重新审查',
          mergeConflictFiles: [],
          changeLogs: [...(task.changeLogs || []), changeLog],
        });
        return;
      }

      const conflicts = await listUnmergedFiles(worktreePath);
      if (!conflicts.length) {
        await abortMerge(worktreePath);
        await this.patchTask(taskId, {
          status: 'paused',
          message: `准备冲突处理失败：${merge.stderr || merge.stdout || 'git merge 执行失败'}`,
        });
        return;
      }

      await this.patchTask(taskId, {
        message: `Agent 正在解决 ${conflicts.length} 个冲突文件…`,
        mergeConflictFiles: conflicts,
      });
      const prompt = [
        `系统正在把基础分支 ${task.baseBranch} 合入任务分支 ${task.taskBranch}。`,
        '当前 worktree 已处于 merge 冲突状态，请逐一解决以下文件中的冲突标记：',
        ...conflicts.map((file) => `- ${file}`),
        '',
        '请保留任务改动，同时吸收基础分支上的最新改动，并检查合并后的逻辑一致性。',
        '不要执行 git commit、git checkout、git merge 或 git abort；系统会负责校验和提交。',
        '完成后简要说明每个冲突的取舍。',
      ].join('\n');
      const { sessionId, summary: agentSummary, error } = await this.continueAgent(
        task,
        prompt,
        worktreePath,
      );

      if (error) {
        await abortMerge(worktreePath);
        await this.patchTask(taskId, {
          status: 'paused',
          message: mergeConflictMessage(conflicts, `Agent 解决冲突失败：${error}`),
          mergeConflictFiles: conflicts,
        });
        return;
      }

      const conflictCheck = await runGit(worktreePath, ['diff', '--check']);
      const markerFiles = [...new Set((conflictCheck.stderr || conflictCheck.stdout)
        .split('\n')
        .filter((line) => /leftover conflict marker/i.test(line))
        .map((line) => line.split(':')[0])
        .filter(Boolean))];
      if (markerFiles.length) {
        await abortMerge(worktreePath);
        await this.patchTask(taskId, {
          status: 'paused',
          message: mergeConflictMessage(markerFiles, 'Agent 未解决全部冲突标记'),
          mergeConflictFiles: markerFiles,
        });
        return;
      }

      const add = await runGit(worktreePath, ['add', '-A']);
      if (!add.ok) {
        await abortMerge(worktreePath);
        await this.patchTask(taskId, {
          status: 'paused',
          message: mergeConflictMessage(conflicts, `冲突文件暂存失败：${add.stderr || add.stdout}`),
          mergeConflictFiles: conflicts,
        });
        return;
      }

      const unresolved = await listUnmergedFiles(worktreePath);
      if (unresolved.length) {
        await abortMerge(worktreePath);
        await this.patchTask(taskId, {
          status: 'paused',
          message: mergeConflictMessage(unresolved, 'Agent 未解决全部冲突'),
          mergeConflictFiles: unresolved,
        });
        return;
      }

      if (await mergeInProgress(worktreePath)) {
        const commit = await runGit(worktreePath, ['commit', '-m', mergeMessage]);
        if (!commit.ok) {
          await abortMerge(worktreePath);
          await this.patchTask(taskId, {
            status: 'paused',
            message: mergeConflictMessage(conflicts, `冲突解决提交失败：${commit.stderr || commit.stdout}`),
            mergeConflictFiles: conflicts,
          });
          return;
        }
      }

      const commitHash = await this.gitCommitHash(worktreePath);
      const changeLog = this.createChangeLog(
        agentSummary || `已解决与基础分支 ${task.baseBranch} 的合并冲突。`,
        agentSummary ? 'agent' : 'git',
        commitHash,
      );
      await this.patchTask(taskId, {
        status: 'review',
        message: '合并冲突已解决，等待重新审查',
        agentSessionId: sessionId ?? task.agentSessionId,
        mergeConflictFiles: [],
        changeLogs: [...(task.changeLogs || []), changeLog],
      });
    } catch (err) {
      let rollbackError = '';
      if (worktreePath && existsSync(worktreePath)) {
        try {
          await abortMerge(worktreePath);
        } catch (abortError) {
          rollbackError = `；${abortError?.message || abortError}`;
        }
      }
      const task = this.tasks.get(taskId);
      if (task) {
        await this.patchTask(taskId, {
          status: 'paused',
          message: `冲突恢复失败：${err?.message || err}${rollbackError}`,
        });
      }
    } finally {
      this.unguard(taskId);
    }
  }

  // ── merge + cleanup ───────────────────────────────────────────────────────

  async mergeTask(taskId) {
    if (!this.guard(taskId)) return;
    try {
      const task = this.tasks.get(taskId);
      if (!task || task.status !== 'approved') return;

      const workspace = this.projectById(task.projectId);
      if (!workspace) {
        await this.patchTask(taskId, { status: 'paused', message: '项目不存在，无法交付变更' });
        return;
      }
      const driver = workspaceDriverForTask(task);
      const reason = await driver.validate(task, workspace);
      if (reason) {
        await this.patchTask(taskId, { status: 'paused', message: reason });
        return;
      }

      let delivered;
      try {
        delivered = await this.withProjectDeliveryLock(
          task.projectId,
          () => driver.deliver(this, task, workspace),
        );
      } catch (err) {
        if (err instanceof MergeConflictError) {
          await this.patchTask(taskId, {
            status: 'paused',
            message: mergeConflictMessage(err.files),
            mergeConflictFiles: err.files,
          });
        } else if (err instanceof SnapshotConflictError) {
          await this.patchTask(taskId, {
            status: 'paused',
            message: snapshotConflictMessage(err.files),
            mergeConflictFiles: err.files,
          });
        } else {
          await this.patchTask(taskId, {
            status: 'paused',
            message: `交付变更失败：${err?.message || err}`,
          });
        }
        return;
      }
      this.invalidateBranch(task.projectId);
      await this.patchTask(taskId, {
        status: 'done',
        message: delivered.message,
        worktreePath: '',
        workspacePath: '',
        backupId: delivered.backupId,
        mergeConflictFiles: [],
      });
      if (driver.kind === 'snapshot') {
        await driver.cleanup(this, task, workspace).catch(async (error) => {
          const current = this.tasks.get(taskId);
          if (current) {
            await this.patchTask(taskId, {
              message: `${current.message}；清理隔离副本失败：${error?.message || error}`,
            });
          }
        });
      }
      await this.deleteKanbanTaskWorkspaces(taskId);
    } finally {
      this.unguard(taskId);
    }
  }

  // ── agent execution ───────────────────────────────────────────────────────

  async spawnAgent(task, cwd, continuationComment = '', continuationAttachments = []) {
    const existingSessionId = primaryAgentSessionId(task);
    if (existingSessionId) {
      return {
        sessionId: existingSessionId,
        error: `任务已经绑定 Agent 会话 ${existingSessionId}，无法新建会话`,
      };
    }
    const sessionId = randomUUID();
    const attachmentFiles = await materializeFileAttachments(task, cwd, continuationAttachments);
    const prompt = buildAgentPrompt(task, cwd, continuationComment, attachmentFiles);
    const attachments = [...normalizedAttachments(task), ...continuationAttachments];

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
          this.ctx.permissionPresets.set(
            agentCtx.agent.session,
            DEFAULT_AGENT_PERMISSION_PRESET,
          );
        },
      });
    } catch (err) {
      return { sessionId, error: `创建 agent 失败：${err?.message || err}` };
    }

    const untrack = this.trackTaskAgent(task.id, handle.agent);

    try {
      await this.recordAgentSession(task.id, handle.agent.session.id);
    } catch (err) {
      await handle.dispose().catch(() => {});
      untrack();
      return { sessionId, error: `保存 Agent 会话失败：${err?.message || err}` };
    }

    try {
      await this.setAgentSessionTitle(handle, task);
    } catch (err) {
      this.ctx.logger?.warn?.('kanban agent session metadata failed: %s', err?.stack || err);
    }

    try {
      if (this.deletingTasks.has(task.id)) {
        return { sessionId, error: '任务正在删除，已取消 Agent 执行' };
      }
      const images = await imageContentBlocks(this.ctx, attachments);
      const message = createUserMessage({
        content: [{ type: 'text', text: prompt }, ...images],
        source: { kind: 'plugin', plugin: 'kanban' },
      });
      const firstSeq = handle.agent.session.seq;
      handle.agent.followup(message);
      await waitForAgentIdle(handle.agent, this.agentTimeoutMs);
      const failure = agentTurnFailure(handle.agent, firstSeq);
      if (failure) return { sessionId, error: failure };
      return { sessionId, summary: await awaitAgentFinalOutput(handle.agent) };
    } catch (err) {
      return { sessionId, error: err?.message || String(err) };
    } finally {
      await handle.dispose().catch(() => {});
      untrack();
    }
  }

  async resumeAgentSession(task, selection) {
    const sessionId = primaryAgentSessionId(task);
    if (!sessionId) throw new Error('任务尚未绑定 Agent 会话，无法继续执行');

    const reuseLiveAgent = () => {
      if (typeof this.ctx.agents.get !== 'function') return null;
      const agent = this.ctx.agents.get(sessionId);
      if (!agent) return null;
      return {
        agent,
        reusedLiveAgent: true,
        // The existing Agent is owned by the execution that made it live.
        dispose: async () => {},
      };
    };

    const liveHandle = reuseLiveAgent();
    if (liveHandle) return liveHandle;
    if (typeof this.ctx.agents.resume !== 'function') {
      throw new Error(`当前 DSH 无法恢复 Agent 会话 ${sessionId}`);
    }

    try {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: selection ? { provider: selection.provider, model: selection.model } : undefined,
        setup: async (agentCtx) => {
          await this.ctx.agentPresets.mount(agentCtx, 'standard');
        },
      });
      if (handle?.agent?.session?.id !== sessionId) {
        await handle?.dispose?.().catch(() => {});
        throw new Error(`恢复后返回了不同的 Agent 会话 ${handle?.agent?.session?.id || 'unknown'}`);
      }
      return handle;
    } catch (err) {
      // The session can become live between get() and resume(). Re-read it so
      // this race does not surface as "cannot prepare session ... while it is live".
      const liveHandle = reuseLiveAgent();
      if (liveHandle) return liveHandle;
      this.ctx.logger?.warn?.('kanban resume agent session failed: %s', err?.stack || err);
      throw new Error(`无法恢复 Agent 会话 ${sessionId}：${err?.message || err}`);
    }
  }

  async continueAgent(task, comment, cwd, attachments = []) {
    const selection =
      task.modelProvider && task.model
        ? { provider: task.modelProvider, model: task.model }
        : this.currentDefaultModel();

    const safeComment = stripInlineImages(comment);
    const sessionId = primaryAgentSessionId(task);
    let handle;
    try {
      handle = await this.resumeAgentSession(task, selection);
    } catch (err) {
      return { sessionId, error: err?.message || String(err) };
    }

    const untrack = this.trackTaskAgent(task.id, handle.agent);

    try {
      if (this.deletingTasks.has(task.id)) {
        return { sessionId, error: '任务正在删除，已取消 Agent 执行' };
      }
      const attachmentFiles = await materializeFileAttachments({ attachments: [] }, cwd, attachments);
      const filesText = attachmentContext(attachmentFiles);
      const startIndex = agentMessages(handle.agent).length;
      const images = await imageContentBlocks(this.ctx, attachments);
      const message = createUserMessage({
        content: [
          {
            type: 'text',
            text: [safeComment, filesText].filter(Boolean).join('\n\n') || '请查看随附附件并继续完成任务。',
          },
          ...images,
        ],
        source: { kind: 'plugin', plugin: 'kanban' },
      });
      const isRunningLiveAgent = handle.reusedLiveAgent && handle.agent.status === 'running';
      const firstSeq = isRunningLiveAgent
        ? activeAgentTurnFirstSeq(handle.agent)
        : handle.agent.session.seq;
      if (!isRunningLiveAgent) handle.agent.followup(message);
      await waitForAgentIdle(handle.agent, this.agentTimeoutMs);
      const failure = agentTurnFailure(handle.agent, firstSeq);
      if (failure) return { sessionId, error: failure };
      return {
        sessionId,
        summary: await awaitAgentFinalOutput(handle.agent, startIndex),
      };
    } catch (err) {
      return { sessionId, error: err?.message || String(err) };
    } finally {
      await handle.dispose().catch(() => {});
      untrack();
    }
  }
}

markRemoteMethods(KanbanService, [
  'getPluginUpdateInfo',
  'startPluginUpdate',
  'acknowledgePluginUpdate',
  'listProjects',
  'getBoard',
  'getTaskImage',
  'listTaskSessions',
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
