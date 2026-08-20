<script setup lang="ts">
import { cva, type VariantProps } from 'class-variance-authority';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { TaskStatus } from '@/lib/types';

const statusVariants = cva('', {
  variants: {
    s: {
      todo: 'bg-status-todo/15 text-status-todo border-status-todo/30',
      running: 'bg-status-running/15 text-status-running border-status-running/30',
      paused: 'bg-status-paused/15 text-status-paused border-status-paused/30',
      review: 'bg-status-review/15 text-status-review border-status-review/30',
      approved: 'bg-status-approved/15 text-status-approved border-status-approved/30',
      done: 'bg-status-done/15 text-status-done border-status-done/30',
    },
  },
});

const props = defineProps<{ s: TaskStatus }>();
</script>

<template>
  <Badge variant="outline" :class="cn(statusVariants({ s: props.s }))">
    <slot />
  </Badge>
</template>
