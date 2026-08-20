<script setup lang="ts">
import { ref } from 'vue';
import { ConfigProvider } from 'reka-ui';
import BoardView from '@/components/BoardView.vue';
import { Toaster } from '@/components/ui/sonner';

const portalTarget = ref<HTMLElement | null>(null);
</script>

<template>
  <div class="dsh-kanban-root h-full w-full text-foreground">
    <ConfigProvider :teleport-to="portalTarget">
      <BoardView />
      <Toaster />
      <div ref="portalTarget" data-kanban-portals="" />
    </ConfigProvider>
  </div>
</template>
