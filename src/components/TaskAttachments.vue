<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Download, FileText, ImageOff } from '@lucide/vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { AttachmentRef } from '@/lib/types';
import { cn } from '@/lib/utils';

const props = defineProps<{
  taskId: string;
  attachments: AttachmentRef[];
}>();

const loadedIds = ref(new Set<string>());
const failedIds = ref(new Set<string>());
const images = computed(() => props.attachments.filter((attachment) => attachment.kind === 'image'));
const files = computed(() => props.attachments.filter((attachment) => attachment.kind !== 'image'));

function attachmentUrl(attachment: AttachmentRef) {
  return `/kanban/attachments/${encodeURIComponent(attachment.attachmentId)}?taskId=${encodeURIComponent(props.taskId)}`;
}

function extension(name?: string) {
  const suffix = name?.split('.').at(-1);
  return suffix && suffix !== name ? suffix.toUpperCase() : 'FILE';
}

function readableSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function markLoaded(attachmentId: string) {
  loadedIds.value = new Set([...loadedIds.value, attachmentId]);
}

function markFailed(attachmentId: string) {
  failedIds.value = new Set([...failedIds.value, attachmentId]);
}

watch(
  () => `${props.taskId}:${props.attachments.map((attachment) => attachment.attachmentId).join(',')}`,
  () => {
    loadedIds.value = new Set();
    failedIds.value = new Set();
  },
);
</script>

<template>
  <div v-if="attachments.length" class="mt-3 flex flex-col gap-2">
    <div v-if="images.length" class="flex flex-wrap gap-2">
      <article
        v-for="attachment in images"
        :key="attachment.attachmentId"
        class="relative size-28 shrink-0 overflow-hidden rounded-xl border bg-muted/30"
      >
        <a
          :href="attachmentUrl(attachment)"
          class="block size-full"
          target="_blank"
          rel="noreferrer"
          :title="attachment.name || '查看任务附件'"
        >
          <div
            v-if="failedIds.has(attachment.attachmentId)"
            class="flex size-full flex-col items-center justify-center gap-2 p-2 text-center text-xs text-muted-foreground"
          >
            <ImageOff class="size-5" aria-hidden="true" />
            <span class="line-clamp-2">{{ attachment.name || '附件加载失败' }}</span>
          </div>
          <template v-else>
            <Skeleton
              v-if="!loadedIds.has(attachment.attachmentId)"
              class="absolute inset-0"
            />
            <img
              :src="attachmentUrl(attachment)"
              :alt="attachment.name || '任务附件'"
              :class="cn('size-full object-cover', !loadedIds.has(attachment.attachmentId) && 'opacity-0')"
              @load="markLoaded(attachment.attachmentId)"
              @error="markFailed(attachment.attachmentId)"
            />
          </template>
        </a>
      </article>
    </div>

    <div v-if="files.length" class="flex flex-wrap gap-2">
      <Button
        v-for="attachment in files"
        :key="attachment.attachmentId"
        as="a"
        variant="outline"
        class="max-w-full justify-start"
        :href="attachmentUrl(attachment)"
        :download="attachment.name || 'attachment'"
        :title="attachment.name"
      >
        <FileText data-icon="inline-start" />
        <Badge variant="secondary">{{ extension(attachment.name) }}</Badge>
        <span class="max-w-52 truncate">{{ attachment.name || '附件' }}</span>
        <span class="text-xs text-muted-foreground">{{ readableSize(attachment.bytes) }}</span>
        <Download data-icon="inline-end" />
      </Button>
    </div>
  </div>
</template>
