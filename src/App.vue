<script setup lang="ts">
import { ref } from 'vue';
import { ConfigProvider } from 'reka-ui';
import BoardView from '@/components/BoardView.vue';
import { Toaster } from '@/components/ui/sonner';
import { useDshAppearance } from '@/composables/useDshAppearance';
import { cn } from '@/lib/utils';

const portalTarget = ref<HTMLElement | null>(null);
const { isDark } = useDshAppearance();
</script>

<template>
  <div :class="cn('dsh-kanban-root h-full w-full bg-background text-foreground', { dark: isDark })">
    <ConfigProvider :teleport-to="portalTarget">
      <BoardView />
      <Toaster :theme="isDark ? 'dark' : 'light'" />
      <div ref="portalTarget" data-kanban-portals="" />
    </ConfigProvider>
  </div>
</template>
