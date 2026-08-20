<script setup lang="ts">
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import KanbanStatusBadge from './KanbanStatusBadge.vue';
import { STATUS_LABEL, type Task } from '@/lib/types';

const props = defineProps<{ task: Task }>();
const emit = defineEmits<{ open: [task: Task] }>();

function onDragStart(e: DragEvent) {
  if (e.dataTransfer) {
    e.dataTransfer.setData('text/kanban-task-id', props.task.id);
    e.dataTransfer.effectAllowed = 'move';
  }
}
</script>

<template>
  <Card
    class="cursor-grab active:cursor-grabbing select-none"
    draggable="true"
    @dragstart="onDragStart"
    @click="emit('open', task)"
  >
    <CardHeader class="p-3">
      <CardTitle class="text-sm font-medium leading-snug">{{ task.title }}</CardTitle>
    </CardHeader>
    <CardContent class="p-3 pt-0">
      <div class="flex items-center gap-2">
        <KanbanStatusBadge :s="task.status">{{ STATUS_LABEL[task.status] }}</KanbanStatusBadge>
        <span class="text-xs text-muted-foreground truncate">{{ task.taskBranch }}</span>
      </div>
      <p v-if="task.message" class="mt-2 text-xs text-muted-foreground line-clamp-2">
        {{ task.message }}
      </p>
    </CardContent>
  </Card>
</template>
