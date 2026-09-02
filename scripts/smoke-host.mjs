import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { Service } from '@deepseek-ai/cordis';
import { KanbanService } from '../lib/index.js';

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'kanban-smoke-'));
const dshHome = await mkdtemp(join(tmpdir(), 'kanban-dsh-home-'));
process.env.DSH_HOME = dshHome;

class FakeResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  get body() {
    return Buffer.concat(this.chunks);
  }
}

function canonicalizedImageData(data, name) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff]),
    createHash('sha256').update(data).update(name).digest(),
  ]);
}

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
  const workspaceEntries = [
    workspace,
    {
      id: 'stale-kanban-workspace',
      title: '看板任务',
      path: join(`${root}.kanban-worktrees`, 'deleted-task'),
      sessionIds: ['deleted-session'],
    },
  ];
  let workspaceCreateCount = 0;
  let failNextAgentTurn = false;
  let hangNextAgentTurn = false;
  let resolveNextConflict = false;
  let turn = 0;
  const registeredRoutes = [];
  const savedAttachments = new Map();
  const sentMessages = [];
  const permissionPresetSelections = [];
  const liveAgents = new Map();
  const storedAgentSessions = new Map();
  const createdAgentSessionIds = [];
  const resumedAgentSessionIds = [];
  const cancelledAgentSessions = [];
  const attachmentStore = {
    imageLimits: {
      maxImagesPerMessage: 10,
      maxMessageImageBytes: 1024 * 1024,
    },
    validateImage: async () => {},
    saveImage: async (input) => {
      const data = canonicalizedImageData(input.data, input.name || 'image');
      const hash = createHash('sha256').update(data).digest('hex');
      const ref = {
        attachmentId: 'sha256:' + hash,
        mediaType: 'image/jpeg',
        // The production store may normalize/re-encode an image before saving
        // it, so its canonical metadata need not match the browser upload.
        bytes: data.byteLength,
        width: 1,
        height: 1,
        name: input.name,
      };
      const objectPath = join(dshHome, 'attachments', 'v1', 'objects', hash.slice(0, 2), hash);
      await mkdir(join(dshHome, 'attachments', 'v1', 'objects', hash.slice(0, 2)), { recursive: true });
      await writeFile(objectPath, data);
      savedAttachments.set(ref.attachmentId, { ref, data });
      return ref;
    },
    readImage: async (ref) => {
      const stored = savedAttachments.get(ref.attachmentId);
      if (!stored) throw new Error('attachment missing');
      for (const field of ['attachmentId', 'mediaType', 'bytes', 'width', 'height', 'name']) {
        if (stored.ref[field] !== ref[field]) {
          throw new Error('Stored attachment metadata does not match its reference.');
        }
      }
      return stored;
    },
  };
  let ctx;
  async function openAgentHandle({ sessionId, meta, setup, resume = false }) {
    let record = storedAgentSessions.get(sessionId);
    if (resume) {
      if (!record) throw new Error(`session not found: ${sessionId}`);
    } else {
      if (record) throw new Error(`session already exists: ${sessionId}`);
      record = { session: { id: sessionId, seq: 0, events: [] }, meta };
      storedAgentSessions.set(sessionId, record);
    }

    const { session } = record;
    const agentCtx = Object.assign(Object.create(ctx), { agent: { session } });
    await setup?.(agentCtx);
    const shouldHang = hangNextAgentTurn;
    hangNextAgentTurn = false;
    let status = 'idle';
    let resolveIdle;
    const idle = shouldHang
      ? new Promise((resolve) => { resolveIdle = resolve; })
      : Promise.resolve();
    const agent = {
      session,
      get status() {
        return status;
      },
      followup(message) {
        sentMessages.push(message);
        if (resolveNextConflict) {
          resolveNextConflict = false;
          writeFileSync(join(record.meta.cwd, 'file.txt'), 'resolved\n');
        }
        turn += 1;
        status = 'running';
        session.events.push({ type: 'turn/start', seq: session.seq++, data: { turn } });
        if (shouldHang) return;
        const reason = failNextAgentTurn
          ? { kind: 'error', error: { code: 'AUTH', message: 'not signed in' } }
          : { kind: 'completed' };
        failNextAgentTurn = false;
        session.events.push({ type: 'turn/end', seq: session.seq++, data: { turn, reason } });
        status = 'idle';
      },
      cancel(cause) {
        cancelledAgentSessions.push({ sessionId, cause });
        if (status === 'running') {
          session.events.push({
            type: 'turn/end',
            seq: session.seq++,
            data: { turn, reason: { kind: 'interrupted' } },
          });
        }
        status = 'idle';
        resolveIdle?.();
      },
      whenIdle: () => idle,
    };
    liveAgents.set(sessionId, agent);
    return {
      agent,
      dispose: async () => {
        if (liveAgents.get(sessionId) === agent) liveAgents.delete(sessionId);
      },
    };
  }

  ctx = {
    reflect: { provide() {}, unregister() {} },
    effect(factory) {
      factory();
    },
    inject(_dependencies, callback) {
      callback(ctx);
    },
    on() {},
    get: (name) => {
      if (name === 'sessionTitle') return { rename: async () => {} };
      if (name === 'attachments') return attachmentStore;
      return undefined;
    },
    logger: console,
    webServer: {
      register(route) {
        registeredRoutes.push(route);
        return () => {
          const index = registeredRoutes.indexOf(route);
          if (index >= 0) registeredRoutes.splice(index, 1);
        };
      },
    },
    storageDomain: { open: async () => domain },
    workspaceRegistry: {
      list: () => [...workspaceEntries],
      get: (id) => workspaceEntries.find((item) => item.id === id),
      create: async (path, title) => {
        const existing = workspaceEntries.find((item) => item.path === path);
        if (existing) return existing;
        workspaceCreateCount += 1;
        const created = {
          id: `kanban-workspace:${path}`,
          title,
          path,
          sessionIds: [],
          async setTitle(nextTitle) {
            this.title = nextTitle;
          },
          async attachSession(sessionId) {
            if (!this.sessionIds.includes(sessionId)) this.sessionIds.unshift(sessionId);
          },
        };
        workspaceEntries.unshift(created);
        return created;
      },
      delete: async (id) => {
        const index = workspaceEntries.findIndex((item) => item.id === id);
        if (index < 0) return false;
        workspaceEntries.splice(index, 1);
        return true;
      },
    },
    agentDefaultModel: { currentSelection: () => null },
    agentPresets: { mount: async () => {} },
    permissionPresets: {
      set: (session, preset) => {
        permissionPresetSelections.push({ sessionId: session.id, preset });
      },
    },
    llm: {
      listProviders: () => [],
      listModels: async () => [],
    },
    agents: {
      get: (sessionId) => liveAgents.get(sessionId),
      create: async ({ sessionId, meta, setup }) => {
        createdAgentSessionIds.push(sessionId);
        return openAgentHandle({ sessionId, meta, setup });
      },
      resume: async ({ resumeSessionId, setup }) => {
        resumedAgentSessionIds.push(resumeSessionId);
        return openAgentHandle({ sessionId: resumeSessionId, setup, resume: true });
      },
    },
  };

  const orphanedAt = new Date(Date.now() - 60_000).toISOString();
  table.map.set('orphaned-running-task', {
    id: 'orphaned-running-task',
    projectId: workspace.id,
    title: 'orphaned running task',
    description: '',
    images: [],
    attachments: [],
    baseBranch: 'master',
    taskBranch: 'kanban/orphaned',
    worktreePath: '',
    status: 'running',
    message: '',
    agentSessionId: null,
    agentSessionIds: [],
    modelProvider: '',
    model: '',
    executeAt: null,
    createdAt: orphanedAt,
    updatedAt: orphanedAt,
    comments: [],
    changeLogs: [],
    mergeConflictFiles: [],
  });

  const service = new KanbanService(ctx);
  await service[Service.init]();
  const recoveredTask = table.get('orphaned-running-task');
  if (
    recoveredTask?.status !== 'paused'
    || !recoveredTask.message.includes('DSH 服务已重启')
  ) {
    throw new Error(`orphaned running task was not recovered: ${JSON.stringify(recoveredTask)}`);
  }
  await table.delete('orphaned-running-task');
  const attachmentRoute = registeredRoutes.find((route) => route.path === '/kanban/attachments');
  if (!attachmentRoute) throw new Error('attachment route was not registered');
  if (kanbanWorkspaces(workspaceEntries).length !== 0) {
    throw new Error(`stale kanban workspaces were not cleaned: ${JSON.stringify(workspaceEntries)}`);
  }

  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const pngData = Buffer.from(pngBase64, 'base64');
  const canonicalTaskPngData = canonicalizedImageData(pngData, 'task.png');
  const canonicalCommentPngData = canonicalizedImageData(pngData, 'comment.png');
  const taskImageAttachment = await uploadAttachment(attachmentRoute, pngData, 'task.png', 'image/png');
  const legacyTaskImageAttachment = {
    ...taskImageAttachment,
    attachmentId: `sha256:${createHash('sha256').update(pngData).digest('hex')}`,
    imageAttachmentId: taskImageAttachment.attachmentId,
    mediaType: 'image/png',
    bytes: pngData.byteLength,
  };
  const taskFileData = Buffer.from('smoke attachment\n');
  const taskFileAttachment = await uploadAttachment(
    attachmentRoute,
    taskFileData,
    'notes.txt',
    'text/plain',
  );
  const task = await service.createTask({
    projectId: workspace.id,
    title: 'smoke task',
    description: '根据截图修复问题',
    attachments: [legacyTaskImageAttachment, taskFileAttachment],
  });
  await waitFor(async () => (await service.getBoard()).tasks[0]?.status === 'review', 'task to reach review');
  if (kanbanWorkspaces(workspaceEntries).length !== 0 || workspaceCreateCount !== 0) {
    throw new Error(`agent run created a real kanban workspace: ${JSON.stringify(workspaceEntries)}`);
  }
  const firstTaskSessions = service.listTaskSessions().sessionIds;
  const firstTask = (await service.getBoard()).tasks[0];
  if (
    !firstTask?.agentSessionId
    || firstTaskSessions.length !== 1
    || firstTaskSessions[0] !== firstTask.agentSessionId
    || JSON.stringify(firstTask.agentSessionIds) !== JSON.stringify(firstTaskSessions)
  ) {
    throw new Error(`unexpected virtual workspace sessions: ${JSON.stringify(firstTask)}`);
  }
  if (
    permissionPresetSelections.length !== 1
    || permissionPresetSelections[0].sessionId !== firstTask.agentSessionId
    || permissionPresetSelections[0].preset !== 'danger-full-access'
  ) {
    throw new Error(`new agent did not default to Full access: ${JSON.stringify(permissionPresetSelections)}`);
  }

  const firstTaskMessage = sentMessages[0];
  const firstTaskImages = firstTaskMessage?.content?.filter((block) => block.type === 'image') ?? [];
  if (firstTaskImages.length !== 1 || firstTaskImages[0].attachment.name !== 'task.png') {
    throw new Error('task image was not delivered to agent: ' + JSON.stringify(firstTaskMessage));
  }
  const firstTaskText = firstTaskMessage?.content?.find((block) => block.type === 'text')?.text || '';
  if (!firstTaskText.includes('notes.txt') || !firstTaskText.includes('.kanban-attachments')) {
    throw new Error('task file was not materialized for agent: ' + JSON.stringify(firstTaskMessage));
  }
  const materializedPath = firstTaskText.match(/：([^\n]+notes\.txt)（/)?.[1];
  if (!materializedPath || !existsSync(materializedPath)) {
    throw new Error('materialized task file is missing: ' + JSON.stringify(materializedPath));
  }
  const taskImage = await service.getTaskImage({
    taskId: task.id,
    attachmentId: firstTask.attachments[0].attachmentId,
  });
  if (taskImage.dataBase64 !== canonicalTaskPngData.toString('base64') || taskImage.name !== 'task.png') {
    throw new Error('task image cannot be read back: ' + JSON.stringify(taskImage));
  }
  const downloadedTaskFile = await requestAttachment(
    attachmentRoute,
    'GET',
    `/kanban/attachments/${encodeURIComponent(taskFileAttachment.attachmentId)}?taskId=${task.id}`,
  );
  if (downloadedTaskFile.statusCode !== 200 || !downloadedTaskFile.body.equals(taskFileData)) {
    throw new Error('task file cannot be downloaded');
  }
  const rangedTaskFile = await requestAttachment(
    attachmentRoute,
    'GET',
    `/kanban/attachments/${encodeURIComponent(taskFileAttachment.attachmentId)}?taskId=${task.id}`,
    Buffer.alloc(0),
    { range: 'bytes=0-4' },
  );
  if (rangedTaskFile.statusCode !== 206 || rangedTaskFile.body.toString() !== 'smoke') {
    throw new Error('task file range request failed');
  }
  const unauthorizedTaskFile = await requestAttachment(
    attachmentRoute,
    'GET',
    `/kanban/attachments/${encodeURIComponent(taskFileAttachment.attachmentId)}?taskId=other-task`,
  );
  if (unauthorizedTaskFile.statusCode !== 404) {
    throw new Error('task attachment ownership was not enforced');
  }

  const commentImageAttachment = await uploadAttachment(attachmentRoute, pngData, 'comment.png', 'image/png');
  const commentFileAttachment = await uploadAttachment(
    attachmentRoute,
    Buffer.from('%PDF smoke\n'),
    'review.pdf',
    'application/pdf',
  );
  await service.commentTask({
    taskId: task.id,
    comment: '请补充一个 smoke 测试',
    attachments: [commentImageAttachment, commentFileAttachment],
  });
  await waitFor(async () => (await service.getBoard()).tasks[0]?.status === 'review', 'task to return to review after comment');
  if (kanbanWorkspaces(workspaceEntries).length !== 0 || workspaceCreateCount !== 0) {
    throw new Error(`continuation created a real kanban workspace: ${JSON.stringify(workspaceEntries)}`);
  }
  const commentedBoard = await service.getBoard();
  const continuedSessions = service.listTaskSessions().sessionIds;
  if (
    continuedSessions.length !== 1
    || commentedBoard.tasks[0]?.agentSessionIds.length !== 1
    || continuedSessions[0] !== firstTask.agentSessionId
    || resumedAgentSessionIds.at(-1) !== firstTask.agentSessionId
  ) {
    throw new Error(`comment continuation changed Agent session: ${JSON.stringify({
      continuedSessions,
      resumedAgentSessionIds,
    })}`);
  }
  const comments = commentedBoard.tasks[0]?.comments ?? [];
  if (
    comments.length !== 1
    || comments[0].content !== '请补充一个 smoke 测试'
    || comments[0].images.length !== 1
    || comments[0].attachments.length !== 2
  ) {
    throw new Error('unexpected comment history: ' + JSON.stringify(comments));
  }
  const commentImage = await service.getTaskImage({
    taskId: task.id,
    attachmentId: comments[0].attachments[0].attachmentId,
  });
  if (commentImage.dataBase64 !== canonicalCommentPngData.toString('base64')) {
    throw new Error('comment image cannot be read back: ' + JSON.stringify(commentImage));
  }
  const continuationImages = sentMessages.at(-1)?.content?.filter((block) => block.type === 'image') ?? [];
  if (continuationImages.length !== 1 || continuationImages[0].attachment.name !== 'comment.png') {
    throw new Error('comment image was not delivered to agent: ' + JSON.stringify(sentMessages.at(-1)));
  }
  const changeLogs = commentedBoard.tasks[0]?.changeLogs ?? [];
  if (changeLogs.length !== 2 || changeLogs.some((log) => log.source !== 'system')) {
    throw new Error(`unexpected change logs after continuation: ${JSON.stringify(changeLogs)}`);
  }

  await service.approveTask({ taskId: task.id });
  await waitFor(async () => (await service.getBoard()).tasks[0]?.status === 'done', 'task to reach done');
  if (kanbanWorkspaces(workspaceEntries).length !== 0) {
    throw new Error(`completed task workspace was not removed: ${JSON.stringify(workspaceEntries)}`);
  }

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
  const conflictSessionId = conflicted.agentSessionId;
  const conflictSessionCreateCount = createdAgentSessionIds.length;
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
  if (
    !conflictSessionId
    || resolvedTask.agentSessionId !== conflictSessionId
    || createdAgentSessionIds.length !== conflictSessionCreateCount
    || resumedAgentSessionIds.at(-1) !== conflictSessionId
  ) {
    throw new Error(`conflict resolution changed Agent session: ${JSON.stringify({
      conflictSessionId,
      resolvedTask,
      createdAgentSessionIds,
      resumedAgentSessionIds,
    })}`);
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
  await assertRejects(
    () => service.deleteTask({ taskId: restoredTask.id }),
    '已完成的任务不可删除',
  );
  if (!table.get(restoredTask.id)) throw new Error('completed task was unexpectedly deleted');

  service.agentTimeoutMs = 10_000;
  hangNextAgentTurn = true;
  const runningTask = await service.createTask({ projectId: workspace.id, title: 'delete running task' });
  await waitFor(
    () => table.get(runningTask.id)?.status === 'running' && liveAgents.size > 0,
    'running task agent to start',
  );
  const runningRecord = table.get(runningTask.id);
  const runningSessionId = runningRecord.agentSessionIds.at(-1);
  if (!existsSync(runningRecord.worktreePath) || !await localBranchExists(root, runningRecord.taskBranch)) {
    throw new Error(`running task git resources were not created: ${JSON.stringify(runningRecord)}`);
  }
  await assertRejects(
    () => service.deleteTask({ taskId: runningTask.id }),
    '执行中的任务不可删除',
  );
  if (!table.get(runningTask.id) || !existsSync(runningRecord.worktreePath)) {
    throw new Error('running task or its worktree was unexpectedly deleted');
  }
  if (cancelledAgentSessions.some((entry) => entry.sessionId === runningSessionId)) {
    throw new Error(`running agent was unexpectedly cancelled: ${JSON.stringify(cancelledAgentSessions)}`);
  }

  liveAgents.get(runningSessionId)?.cancel({ kind: 'user' });
  await waitFor(
    () => table.get(runningTask.id)?.status === 'paused',
    'cancelled task to pause',
  );
  const deletion = await service.deleteTask({ taskId: runningTask.id });
  if (!deletion.deleted || table.get(runningTask.id)) {
    throw new Error(`running task was not deleted: ${JSON.stringify(deletion)}`);
  }
  if (existsSync(runningRecord.worktreePath) || await localBranchExists(root, runningRecord.taskBranch)) {
    throw new Error(`deleted task git resources remain: ${JSON.stringify(runningRecord)}`);
  }

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
  const failedSessionId = failed.agentSessionId;
  const failedSessionCreateCount = createdAgentSessionIds.length;
  if (
    !failedSessionId
    || JSON.stringify(failed.agentSessionIds) !== JSON.stringify([failedSessionId])
  ) {
    throw new Error(`failed task did not retain its Agent session: ${JSON.stringify(failed)}`);
  }
  await service.resumeTask({ taskId: failedTask.id });
  await waitFor(
    async () => (await service.getBoard()).tasks.find((item) => item.id === failedTask.id)?.status === 'review',
    'failed agent task to return to review in the same session',
  );
  const resumedFailed = (await service.getBoard()).tasks.find((item) => item.id === failedTask.id);
  if (
    resumedFailed.agentSessionId !== failedSessionId
    || JSON.stringify(resumedFailed.agentSessionIds) !== JSON.stringify([failedSessionId])
    || createdAgentSessionIds.length !== failedSessionCreateCount
    || resumedAgentSessionIds.at(-1) !== failedSessionId
  ) {
    throw new Error(`resumed task changed Agent session: ${JSON.stringify({
      failedSessionId,
      resumedFailed,
      createdAgentSessionIds,
      resumedAgentSessionIds,
    })}`);
  }
  await service.deleteTask({ taskId: failedTask.id });

  service.agentTimeoutMs = 25;
  hangNextAgentTurn = true;
  const timedOutTask = await service.createTask({ projectId: workspace.id, title: 'timed out agent task' });
  await waitFor(
    async () => (await service.getBoard()).tasks.find((item) => item.id === timedOutTask.id)?.status === 'paused',
    'timed out agent task to pause',
  );
  const timedOut = (await service.getBoard()).tasks.find((item) => item.id === timedOutTask.id);
  if (timedOut?.message !== 'agent 执行失败：agent 执行超时，请稍后重试') {
    throw new Error(`unexpected timed out agent message: ${JSON.stringify(timedOut)}`);
  }
  await service.deleteTask({ taskId: timedOutTask.id });
  if (kanbanWorkspaces(workspaceEntries).length !== 0) {
    throw new Error(`deleted task workspace was not removed: ${JSON.stringify(workspaceEntries)}`);
  }
  console.log('smoke-host: ok');
} finally {
  await rm(`${root}.kanban-worktrees`, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
  await rm(dshHome, { recursive: true, force: true });
}

async function requestAttachment(route, method, url, body = Buffer.alloc(0), headers = {}) {
  const req = Readable.from(body.length ? [body] : []);
  req.method = method;
  req.url = url;
  req.headers = headers;
  const res = new FakeResponse();
  await route.handler(req, res);
  if (!res.writableFinished) await once(res, 'finish');
  return res;
}

async function uploadAttachment(route, body, name, mediaType) {
  const response = await requestAttachment(route, 'POST', '/kanban/attachments', body, {
    'content-length': String(body.byteLength),
    'content-type': mediaType,
    'x-kanban-file-name': encodeURIComponent(name),
  });
  if (response.statusCode !== 201) {
    throw new Error(`attachment upload failed: ${response.statusCode} ${response.body}`);
  }
  return JSON.parse(response.body.toString('utf8'));
}

async function waitFor(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function kanbanWorkspaces(workspaces) {
  return workspaces.filter((item) => item.title.endsWith('看板任务'));
}

async function localBranchExists(cwd, branch) {
  const result = await execFileAsync('git', ['-C', cwd, 'branch', '--list', branch]);
  return Boolean(result.stdout.trim());
}

async function assertRejects(operation, expectedMessage) {
  try {
    await operation();
  } catch (error) {
    if (error?.message === expectedMessage) return;
    throw new Error(`unexpected rejection: ${error?.message || error}`);
  }
  throw new Error(`expected rejection: ${expectedMessage}`);
}
