import { computed, reactive, ref } from 'vue';
import { unwrap, useKanbanApi } from '@/lib/bridge';
import { STATUSES, type Board, type Project, type Task, type TaskStatus } from '@/lib/types';

export function useBoard() {
  const api = useKanbanApi();

  const projects = ref<Project[]>([]);
  const tasks = ref<Task[]>([]);
  const selectedProjectId = ref<string | null>(null);
  const loading = ref(false);
  const loaded = ref(false);
  const boardVersion = ref<string | null>(null);
  const busy = reactive<Record<string, boolean>>({});

  const selectedProject = computed(() =>
    projects.value.find((p) => p.id === selectedProjectId.value) ?? null,
  );

  const selectedTasks = computed(() =>
    selectedProjectId.value
      ? tasks.value.filter((t) => t.projectId === selectedProjectId.value)
      : [],
  );

  const columns = computed(() =>
    STATUSES.map((s) => ({
      ...s,
      tasks: selectedTasks.value.filter((t) => t.status === s.id),
    })),
  );

  async function load() {
    loading.value = true;
    try {
      const board: Board = await unwrap(api.getBoard());
      if (boardVersion.value === board.version) return;
      boardVersion.value = board.version;
      projects.value = board.projects;
      tasks.value = board.tasks;
      if (!selectedProjectId.value && board.projects.length) {
        selectedProjectId.value = board.projects[0].id;
      }
    } finally {
      loading.value = false;
    }
    loaded.value = true;
  }

  async function createTask(input: {
    title: string;
    description?: string;
    baseBranch?: string;
    modelProvider?: string;
    model?: string;
    executeAt?: string | null;
  }) {
    if (!selectedProjectId.value) throw new Error('请先选择项目');
    const task = await unwrap(
      api.createTask({ projectId: selectedProjectId.value, ...input }),
    );
    tasks.value = [task, ...tasks.value.filter((t) => t.id !== task.id)];
    return task;
  }

  async function moveTask(taskId: string, to: TaskStatus) {
    busy[taskId] = true;
    try {
      const updated = await unwrap(api.moveTask({ taskId, to }));
      tasks.value = tasks.value.map((t) => (t.id === updated.id ? updated : t));
      return updated;
    } finally {
      delete busy[taskId];
    }
  }

  async function approveTask(taskId: string) {
    busy[taskId] = true;
    try {
      const updated = await unwrap(api.approveTask({ taskId }));
      tasks.value = tasks.value.map((t) => (t.id === updated.id ? updated : t));
      return updated;
    } finally {
      delete busy[taskId];
    }
  }

  async function resumeTask(taskId: string) {
    busy[taskId] = true;
    try {
      const updated = await unwrap(api.resumeTask({ taskId }));
      tasks.value = tasks.value.map((t) => (t.id === updated.id ? updated : t));
      return updated;
    } finally {
      delete busy[taskId];
    }
  }

  async function commentTask(taskId: string, comment: string) {
    busy[taskId] = true;
    try {
      const updated = await unwrap(api.commentTask({ taskId, comment }));
      tasks.value = tasks.value.map((t) => (t.id === updated.id ? updated : t));
      return updated;
    } finally {
      delete busy[taskId];
    }
  }

  async function deleteTask(taskId: string) {
    busy[taskId] = true;
    try {
      await unwrap(api.deleteTask({ taskId }));
      tasks.value = tasks.value.filter((t) => t.id !== taskId);
    } finally {
      delete busy[taskId];
    }
  }

  return reactive({
    projects,
    tasks,
    selectedProjectId,
    selectedProject,
    selectedTasks,
    columns,
    loading,
    loaded,
    boardVersion,
    busy,
    load,
    createTask,
    moveTask,
    approveTask,
    resumeTask,
    commentTask,
    deleteTask,
  });
}
