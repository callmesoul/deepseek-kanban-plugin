import { inject } from 'vue';
import type { Board, CreateTaskOptions, Project, RemoteResult, Task, TaskStatus } from './types';

export interface KanbanApi {
  listProjects(): Promise<RemoteResult<Project[]>>;
  getBoard(): Promise<RemoteResult<Board>>;
  listCreateTaskOptions(): Promise<RemoteResult<CreateTaskOptions>>;
  listBranches(input: { projectId: string }): Promise<RemoteResult<{ branches: string[]; current: string }>>;
  createTask(input: {
    projectId: string;
    title: string;
    description?: string;
    baseBranch?: string;
    modelProvider?: string;
    model?: string;
    executeAt?: string | null;
  }): Promise<RemoteResult<Task>>;
  moveTask(input: { taskId: string; to: TaskStatus }): Promise<RemoteResult<Task>>;
  approveTask(input: { taskId: string }): Promise<RemoteResult<Task>>;
  resumeTask(input: { taskId: string }): Promise<RemoteResult<Task>>;
  commentTask(input: { taskId: string; comment: string }): Promise<RemoteResult<Task>>;
  deleteTask(input: { taskId: string }): Promise<RemoteResult<{ deleted: boolean }>>;
}

export const KANBAN_API = Symbol('kanban-api');

export function useKanbanApi(): KanbanApi {
  const injected = inject<KanbanApi>(KANBAN_API);
  if (injected) return injected;
  const global = (window as any).__kanbanApi as KanbanApi | undefined;
  if (global) return global;
  throw new Error('KanbanApi missing: provide via app.provide(KANBAN_API, …) or window.__kanbanApi');
}

/** Unwrap a RemoteResult, throwing the error branch as a plain Error. */
export async function unwrap<T>(p: Promise<RemoteResult<T>>): Promise<T> {
  const r = await p;
  if (r.ok) return r.value;
  const error = (r as { ok: false; error: { code: string; message: string; details?: object } }).error;
  throw new Error(error?.message || error?.code || '远程调用失败');
}
