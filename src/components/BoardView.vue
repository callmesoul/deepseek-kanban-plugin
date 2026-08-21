<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { toast } from 'vue-sonner';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { LayoutGrid, Map, RefreshCw } from '@lucide/vue';
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from '@/components/ui/tabs';
import { useBoard } from '@/composables/useBoard';
import KanbanColumn from './KanbanColumn.vue';
import NewTaskDialog from './NewTaskDialog.vue';
import RoadmapView from './RoadmapView.vue';
import TaskDetailSheet from './TaskDetailSheet.vue';
import type { Task, TaskStatus } from '@/lib/types';

const board = useBoard();
const detailTaskId = ref<string | null>(null);
const detailTask = computed<Task | null>(() =>
  board.tasks.find((t) => t.id === detailTaskId.value) ?? null,
);
const detailBusy = ref(false);
const submitting = ref(false);
let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 4000;

async function refresh() {
  try {
    await board.load();
  } catch (e: any) {
    toast.error(e?.message || '加载看板失败');
  }
}

async function handleCreate(input: {
  projectId: string;
  title: string;
  description: string;
  baseBranch: string;
  modelProvider?: string;
  model?: string;
  executeAt?: string | null;
}) {
  submitting.value = true;
  try {
    await board.createTask(input);
    toast.success(input.executeAt ? '任务已创建，将在执行时间自动开始' : '任务已创建，agent 正在领取执行');
  } catch (e: any) {
    toast.error(e?.message || '创建任务失败');
  } finally {
    submitting.value = false;
  }
}

async function handleDrop(taskId: string, to: TaskStatus) {
  try {
    await board.moveTask(taskId, to);
    toast.success('状态已更新');
  } catch (e: any) {
    toast.error(e?.message || '更新状态失败');
  }
}

function openDetail(task: Task) {
  detailTaskId.value = task.id;
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
}

function handleVisibilityChange() {
  if (document.visibilityState === 'visible') {
    refresh();
    startPolling();
  } else {
    stopPolling();
  }
}

async function handleApprove(taskId: string) {
  detailBusy.value = true;
  try {
    await board.approveTask(taskId);
    toast.success('已审核，agent 正在合回基础分支');
    detailTaskId.value = null;
  } catch (e: any) {
    toast.error(e?.message || '审核失败');
  } finally {
    detailBusy.value = false;
  }
}

async function handleResume(taskId: string) {
  detailBusy.value = true;
  try {
    await board.resumeTask(taskId);
    toast.success('已继续执行');
    detailTaskId.value = null;
  } catch (e: any) {
    toast.error(e?.message || '继续执行失败');
  } finally {
    detailBusy.value = false;
  }
}

async function handleComment(taskId: string, comment: string) {
  detailBusy.value = true;
  try {
    await board.commentTask(taskId, comment);
    toast.success('评论已发送，agent 正在继续执行');
    detailTaskId.value = null;
  } catch (e: any) {
    toast.error(e?.message || '发送评论失败');
  } finally {
    detailBusy.value = false;
  }
}

async function handleRemove(taskId: string) {
  detailBusy.value = true;
  try {
    await board.deleteTask(taskId);
    toast.success('任务已删除');
    detailTaskId.value = null;
  } catch (e: any) {
    toast.error(e?.message || '删除失败');
  } finally {
    detailBusy.value = false;
  }
}

onMounted(() => {
  refresh();
  startPolling();
  document.addEventListener('visibilitychange', handleVisibilityChange);
});

onUnmounted(() => {
  stopPolling();
  document.removeEventListener('visibilitychange', handleVisibilityChange);
});
</script>

<template>
  <div class="flex flex-col h-full gap-3 p-4">
    <div class="flex items-center gap-2">
      <Select
        :model-value="board.selectedProjectId ?? undefined"
        @update:model-value="(v) => (board.selectedProjectId = v as string)"
      >
        <SelectTrigger class="w-64">
          <SelectValue placeholder="选择项目" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem v-for="p in board.projects" :key="p.id" :value="p.id">
              {{ p.title }}
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>

      <Button variant="ghost" size="icon" aria-label="刷新" @click="refresh">
        <RefreshCw data-icon="inline-start" />
      </Button>

      <div class="ml-auto">
        <NewTaskDialog
          :projects="board.projects"
          :selected-project-id="board.selectedProjectId"
          :submitting="submitting"
          @update:selected-project-id="(id) => (board.selectedProjectId = id)"
          @create="handleCreate"
        />
      </div>
    </div>

    <TabsRoot default-value="board" class="flex min-h-0 flex-1 flex-col gap-3">
      <TabsList class="w-fit">
        <TabsTrigger value="board">
          <LayoutGrid />
          看板
        </TabsTrigger>
        <TabsTrigger value="roadmap">
          <Map />
          路线图
        </TabsTrigger>
      </TabsList>

      <TabsContent value="board" class="flex-1 min-h-0">
        <div
          v-if="!board.loaded && board.loading && board.tasks.length === 0"
          class="grid grid-cols-6 gap-3 h-full grid-rows-[1fr]"
        >
          <Skeleton v-for="i in 6" :key="i" class="h-full min-h-[200px]" />
        </div>

        <div
          v-else
          class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 h-full grid-rows-[1fr]"
        >
          <KanbanColumn
            v-for="col in board.columns"
            :key="col.id"
            :id="col.id"
            :label="col.label"
            :tasks="col.tasks"
            @drop="handleDrop"
            @open="openDetail"
          />
        </div>
      </TabsContent>

      <TabsContent value="roadmap" class="flex-1 min-h-0">
        <div v-if="!board.loaded && board.loading && board.tasks.length === 0" class="h-full">
          <Skeleton class="h-full min-h-[200px] w-full" />
        </div>
        <RoadmapView v-else :tasks="board.selectedTasks" @open="openDetail" />
      </TabsContent>
    </TabsRoot>

    <TaskDetailSheet
      :task="detailTask"
      :busy="detailBusy"
      @approve="handleApprove"
      @resume="handleResume"
      @comment="handleComment"
      @remove="handleRemove"
      @close="detailTaskId = null"
    />
  </div>
</template>
