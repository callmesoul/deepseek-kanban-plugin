import { execFile } from 'node:child_process';
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
      create: async ({ sessionId }) => ({
        agent: {
          session: { id: sessionId },
          followup() {},
          whenIdle: async () => {},
        },
        dispose: async () => {},
      }),
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
