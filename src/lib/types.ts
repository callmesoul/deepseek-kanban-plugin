export type TaskStatus = 'todo' | 'running' | 'paused' | 'review' | 'approved' | 'done';

export const STATUSES: { id: TaskStatus; label: string }[] = [
  { id: 'todo', label: '待领取' },
  { id: 'running', label: '执行中' },
  { id: 'paused', label: '暂停中' },
  { id: 'review', label: '待审查' },
  { id: 'approved', label: '已审核' },
  { id: 'done', label: '已完成' },
];

export const STATUS_LABEL: Record<TaskStatus, string> = STATUSES.reduce(
  (acc, s) => ((acc[s.id] = s.label), acc),
  {} as Record<TaskStatus, string>,
);

export interface Project {
  id: string;
  title: string;
  path: string;
  branch: string;
  git: boolean;
}

export interface AttachmentRef {
  attachmentId: string;
  kind: 'image' | 'file';
  mediaType: string;
  bytes: number;
  width?: number;
  height?: number;
  name?: string;
  imageAttachmentId?: string;
}

export type ImageAttachmentRef = AttachmentRef;

export interface TaskImageData {
  attachmentId: string;
  mediaType: ImageAttachmentRef['mediaType'];
  name?: string;
  dataBase64: string;
}

export interface TaskComment {
  id: string;
  content: string;
  createdAt: string;
  attachments: AttachmentRef[];
  images: ImageAttachmentRef[];
}

export interface TaskChangeLog {
  id: string;
  summary: string;
  source: 'agent' | 'git' | 'system';
  commit: string | null;
  createdAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  attachments: AttachmentRef[];
  images: ImageAttachmentRef[];
  baseBranch: string;
  taskBranch: string;
  worktreePath: string;
  status: TaskStatus;
  message: string;
  agentSessionId: string | null;
  agentSessionIds: string[];
  modelProvider: string | null;
  model: string | null;
  executeAt: string | null;
  createdAt: string;
  updatedAt: string;
  comments: TaskComment[];
  changeLogs: TaskChangeLog[];
  mergeConflictFiles: string[];
}

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
}

export interface ModelProviderGroup {
  id: string;
  name: string;
  models: ModelOption[];
}

export interface CreateTaskOptions {
  groups: ModelProviderGroup[];
  defaultModel: {
    provider: string;
    model: string;
  } | null;
}

export interface Board {
  projects: Project[];
  tasks: Task[];
  statuses: { id: TaskStatus; label: string }[];
  version: string;
}

export type PluginUpdateStatus = 'installing' | 'restarting' | 'succeeded' | 'failed';

export interface PluginRelease {
  version: string;
  tagName: string;
  name: string;
  notes: string;
  publishedAt: string | null;
  url: string;
}

export interface PluginUpdateState {
  status: PluginUpdateStatus;
  targetVersion: string;
  tagName: string;
  message?: string;
  installedVersion?: string;
  requiresRestart?: boolean;
  startedAt?: string;
  finishedAt?: string;
}

export interface PluginUpdateInfo {
  currentVersion: string;
  enabled: boolean;
  disabledReason: 'not-installed' | 'development-install' | 'unsupported-source' | null;
  installedSpec: string | null;
  checkedAt: string | null;
  checkError: string | null;
  update: PluginRelease | null;
  state: PluginUpdateState | null;
}

export type RemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details?: object } };
