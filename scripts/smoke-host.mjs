import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Service } from '@deepseek-ai/cordis';
import { KanbanService } from '../lib/index.js';

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'kanban-smoke-'));

try {
  await execFileAsync('git', ['init', '-q', root]);
  await execFileAsync('git', ['-C', root, 'config', 'user.email', 'smoke@example.com']);
  await execFileAsync('git', ['-C', root, 'config', 'user.name', 'kanban smoke']);
  await execFileAsync('sh', ['-c', `printf 'hello\\n' > ${JSON.stringify(join(root, 'file.txt'))}`]);
  await execFileAsync('git', ['-C', root, 'add', 'file.txt']);
  await execFileAsync('git', ['-C', root, 'commit', '-qm', 'initial']);

  class FakeTable {
    map = new Map();
    get(key) { return this.map.get(key); }
    entries() { return [...this.map.entries()][Symbol.iterator](); }
    async put(key, value) { this.map.set(key, value); }
    async delete(key) { return this.map.delete(key); }
  }

  const table = new FakeTable();
  const domain = { table: () => table, close: async () => {} };
  const workspace = { id: 'ws-1', title: 'smoke', path: root };
  let failNextAgentTurn = false;
  let resolveNextConflict = false;
  let turn = 0;
  const ctx = {
    reflect: { provide() {}, unregister() {} },
    effect() {},
    on() {},
    get: (name) => (name === 'sessionTitle' ? { rename: async () => {} } : undefined),
    logger: console,
    storageDomain: { open: async () => domain },
    workspaceRegistry: {
      list: () => [workspace],
      get: (id) => (id === workspace.id ? workspace : undefined),
      create: async (path, title) => ({
        id: `kanban-workspace:${path}`,
        title,
        path,
        attachSession: async () => {},
      }),
    },
    agentDefaultModel: { currentSelection: () => null },
    agentPresets: { mount: async () => {} },
    llm: {
      listProviders: () => [],
      listModels: async () => [],
    },
    agents: {
      create: async ({ sessionId, meta }) => {
        const session = { id: sessionId, seq: 0, events: [] };
        return {
          agent: {
            session,
            followup() {
              if (resolveNextConflict) {
                resolveNextConflict = false;
                writeFileSync(join(meta.cwd, 'file.txt'), 'resolved\n');
              }
              turn += 1;
              session.events.push({ type: 'turn/start', seq: session.seq++, data: { turn } });
              const reason = failNextAgentTurn
                ? { kind: 'error', error: { code: 'AUTH', message: 'not signed in' } }
                : { kind: 'completed' };
              failNextAgentTurn = false;
              session.events.push({ type: 'turn/end', seq: session.seq++, data: { turn, reason } });
            },
            whenIdle: async () => {},
          },
          dispose: async () => {},
        };
      },
    },
  };

  const service = new KanbanService(ctx);
  await service[Service.init]();

  const task = await service.createTask({ projectId: workspace.id, title: 'smoke task' });
  await waitFor(async () => (await service.getBoard()).tasks[0]?.status === 'review', 'task to reach review');

  await service.commentTask({ taskId: task.id, comment: '请补充一个 smoke 测试' });
  await waitFor(async () => (await service.getBoard()).tasks[0]?.status === 'review', 'task to return to review after comment');
  const commentedBoard = await service.getBoard();
  const comments = commentedBoard.tasks[0]?.comments ?? [];
  if (comments.length !== 1 || comments[0].content !== '请补充一个 smoke 测试') {
    throw new Error(`unexpected comment history: ${JSON.stringify(comments)}`);
  }
  const changeLogs = commentedBoard.tasks[0]?.changeLogs ?? [];
  if (changeLogs.length !== 2 || changeLogs.some((log) => log.source !== 'system')) {
    throw new Error(`unexpected change logs after continuation: ${JSON.stringify(changeLogs)}`);
  }

  await service.approveTask({ taskId: task.id });
  await waitFor(async () => (await service.getBoard()).tasks[0]?.status === 'done', 'task to reach done');

  const board = await service.getBoard();
  if (board.tasks[0]?.status !== 'done') throw new Error(`unexpected final status: ${board.tasks[0]?.status}`);
  if (board.projects[0]?.branch !== 'master') throw new Error(`unexpected branch after merge: ${board.projects[0]?.branch}`);
  if ((board.tasks[0]?.changeLogs ?? []).length !== 2) {
    throw new Error(`expected two change logs, got: ${JSON.stringify(board.tasks[0]?.changeLogs ?? [])}`);
  }

  const conflictTask = await service.createTask({ projectId: workspace.id, title: 'conflict task' });
  await waitFor(
    async () => (await service.getBoard()).tasks.find((item) => item.id === conflictTask.id)?.status === 'review',
    'conflict task to reach review',
  );
  const conflictWorktree = (await service.getBoard()).tasks
    .find((item) => item.id === conflictTask.id)?.worktreePath;
  if (!conflictWorktree) throw new Error('conflict task worktree missing');

  writeFileSync(join(conflictWorktree, 'file.txt'), 'task branch\n');
  await execFileAsync('git', ['-C', conflictWorktree, 'add', 'file.txt']);
  await execFileAsync('git', ['-C', conflictWorktree, 'commit', '-qm', 'task branch change']);
  writeFileSync(join(root, 'file.txt'), 'base branch\n');
  await execFileAsync('git', ['-C', root, 'add', 'file.txt']);
  await execFileAsync('git', ['-C', root, 'commit', '-qm', 'base branch change']);

  await service.approveTask({ taskId: conflictTask.id });
  await waitFor(
    async () => (await service.getBoard()).tasks.find((item) => item.id === conflictTask.id)?.status === 'paused',
    'conflict task to pause after merge conflict',
  );
  const conflicted = (await service.getBoard()).tasks.find((item) => item.id === conflictTask.id);
  if (JSON.stringify(conflicted?.mergeConflictFiles) !== JSON.stringify(['file.txt'])) {
    throw new Error(`unexpected conflict files: ${JSON.stringify(conflicted)}`);
  }
  if (!conflicted?.message.includes('已安全回滚')) {
    throw new Error(`missing rollback message: ${JSON.stringify(conflicted)}`);
  }
  const rootStatus = await execFileAsync('git', ['-C', root, 'status', '--porcelain']);
  if (rootStatus.stdout.trim()) throw new Error(`main worktree left dirty: ${rootStatus.stdout}`);
  const mergeStillActive = await execFileAsync(
    'git', ['-C', root, 'rev-parse', '--verify', '-q', 'MERGE_HEAD'],
  ).then(() => true, () => false);
  if (mergeStillActive) throw new Error('main worktree still has MERGE_HEAD');

  resolveNextConflict = true;
  await service.resumeTask({ taskId: conflictTask.id });
  await waitFor(
    async () => (await service.getBoard()).tasks.find((item) => item.id === conflictTask.id)?.status === 'review',
    'conflict task to return to review after resolution',
  );
  const resolvedTask = (await service.getBoard()).tasks.find((item) => item.id === conflictTask.id);
  if (resolvedTask?.mergeConflictFiles.length) {
    throw new Error(`conflicts were not cleared: ${JSON.stringify(resolvedTask)}`);
  }

  await service.approveTask({ taskId: conflictTask.id });
  await waitFor(
    async () => (await service.getBoard()).tasks.find((item) => item.id === conflictTask.id)?.status === 'done',
    'resolved conflict task to reach done',
  );
  const resolvedContent = await execFileAsync('git', ['-C', root, 'show', 'HEAD:file.txt']);
  if (resolvedContent.stdout !== 'resolved\n') {
    throw new Error(`unexpected resolved content: ${JSON.stringify(resolvedContent.stdout)}`);
  }

  const restoredTask = await service.createTask({ projectId: workspace.id, title: 'restored approved task' });
  await waitFor(
    async () => (await service.getBoard()).tasks.find((item) => item.id === restoredTask.id)?.status === 'review',
    'restored task to reach review',
  );
  const restoreCandidate = table.get(restoredTask.id);
  table.map.set(restoredTask.id, {
    ...restoreCandidate,
    status: 'approved',
    message: '等待合回基础分支…',
  });
  service.restoreApprovedTasks();
  await waitFor(
    async () => (await service.getBoard()).tasks.find((item) => item.id === restoredTask.id)?.status === 'done',
    'approved task to resume merge after restore',
  );

  failNextAgentTurn = true;
  const failedTask = await service.createTask({ projectId: workspace.id, title: 'failed agent task' });
  await waitFor(
    async () => (await service.getBoard()).tasks.find((item) => item.id === failedTask.id)?.status === 'paused',
    'failed agent task to pause',
  );
  const failed = (await service.getBoard()).tasks.find((item) => item.id === failedTask.id);
  if (failed?.message !== 'agent 执行失败：not signed in') {
    throw new Error(`unexpected failed agent message: ${JSON.stringify(failed)}`);
  }
  console.log('smoke-host: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}

async function waitFor(check, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}
