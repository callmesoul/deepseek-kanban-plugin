<script setup lang="ts">
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Inbox } from '@lucide/vue';
import TaskCard from './TaskCard.vue';
import type { Task, TaskStatus } from '@/lib/types';

const props = defineProps<{
  id: TaskStatus;
  label: string;
  tasks: Task[];
}>();

const emit = defineEmits<{ drop: [taskId: string, status: TaskStatus]; open: [task: Task] }>();

function onDrop(e: DragEvent) {
  const taskId = e.dataTransfer?.getData('text/kanban-task-id');
  if (taskId) emit('drop', taskId, props.id);
}
</script>

<template>
  <div class="flex flex-col rounded-xl border bg-muted/30 min-w-0">
    <div class="flex items-center gap-2 px-3 py-2.5 border-b">
      <span class="text-sm font-medium">{{ label }}</span>
      <Badge variant="secondary" class="ml-auto">{{ tasks.length }}</Badge>
    </div>
    <ScrollArea class="flex-1 min-h-0">
      <div
        class="flex flex-col gap-2 p-2 min-h-[4rem]"
        @dragover.prevent
        @drop="onDrop"
      >
        <TaskCard
          v-for="task in tasks"
          :key="task.id"
          :task="task"
          @open="(t) => emit('open', t)"
        />
        <Empty v-if="tasks.length === 0" class="py-6">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Inbox /></EmptyMedia>
            <EmptyTitle>暂无任务</EmptyTitle>
            <EmptyDescription>拖拽或新建任务到这里</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    </ScrollArea>
  </div>
</template>
