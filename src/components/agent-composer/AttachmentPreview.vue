<script setup lang="ts">
import { FileTextIcon, XIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { ComposerAttachment } from './types'

const props = defineProps<{
  attachment: ComposerAttachment
}>()

const emit = defineEmits<{
  remove: [id: string]
}>()

const extension = computed(() => {
  const parts = props.attachment.file.name.split('.')
  return parts.length > 1 ? parts.at(-1)?.toUpperCase() : 'FILE'
})

const readableSize = computed(() => {
  const bytes = props.attachment.file.size
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
})
</script>

<template>
  <article
    class="group relative flex size-24 shrink-0 flex-col overflow-hidden rounded-xl border bg-muted/30"
  >
    <img
      v-if="attachment.previewUrl"
      :src="attachment.previewUrl"
      :alt="attachment.file.name"
      class="size-full object-cover"
    />

    <div v-else class="flex min-h-0 flex-1 flex-col justify-between gap-2 p-2.5">
      <div class="flex items-center gap-1.5 text-muted-foreground">
        <FileTextIcon class="size-4" aria-hidden="true" />
        <Badge variant="secondary">{{ extension }}</Badge>
      </div>
      <div class="min-w-0">
        <p class="truncate text-xs font-medium" :title="attachment.file.name">
          {{ attachment.file.name }}
        </p>
        <p class="text-[0.6875rem] text-muted-foreground">{{ readableSize }}</p>
      </div>
    </div>

    <Button
      type="button"
      variant="secondary"
      size="icon-xs"
      class="absolute right-1 top-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
      :aria-label="`移除 ${attachment.file.name}`"
      @click="emit('remove', attachment.id)"
    >
      <XIcon />
    </Button>
  </article>
</template>
