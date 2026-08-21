<script setup lang="ts">
import { File, Folder, FolderOpen } from '@lucide/vue';
import { Spinner } from '@/components/ui/spinner';
import type { PathSuggestionItem } from '@/composables/usePathAutocomplete';

defineProps<{
  open: boolean;
  loading: boolean;
  hasError?: boolean;
  items: PathSuggestionItem[];
  activeIndex: number;
  position: { top: number; left: number };
  total: number;
}>();

const emit = defineEmits<{
  select: [index: number];
  hover: [index: number];
}>();
</script>

<template>
  <div
    v-if="open"
    role="listbox"
    aria-label="项目目录路径补全"
    class="kb-path-suggest absolute z-50 w-72 max-w-[calc(100%-0.5rem)] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
    :style="{ top: `${position.top}px`, left: `${position.left}px` }"
    @mousedown.prevent
  >
    <div class="max-h-56 overflow-y-auto p-1">
      <div
        v-if="loading"
        class="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground"
      >
        <Spinner class="size-3.5" />
        正在加载项目目录…
      </div>

      <div
        v-else-if="hasError"
        class="px-2.5 py-2 text-xs text-muted-foreground"
      >
        项目目录加载失败，请重试
      </div>

      <div
        v-else-if="items.length === 0"
        class="px-2.5 py-2 text-xs text-muted-foreground"
      >
        没有匹配的路径
      </div>

      <template v-else>
        <button
          v-for="(item, i) in items"
          :key="item.path"
          type="button"
          role="option"
          :aria-selected="i === activeIndex"
          class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors"
          :class="i === activeIndex ? 'bg-accent text-accent-foreground' : 'text-foreground'"
          @click="emit('select', i)"
          @mouseenter="emit('hover', i)"
        >
          <FolderOpen
            v-if="item.isDir"
            class="size-3.5 shrink-0 text-muted-foreground"
          />
          <File
            v-else
            class="size-3.5 shrink-0 text-muted-foreground"
          />
          <span class="min-w-0 flex-1 truncate font-mono">/{{ item.path }}</span>
          <span
            v-if="item.isDir"
            class="shrink-0 text-[10px] text-muted-foreground"
          >
            目录
          </span>
        </button>
      </template>
    </div>

    <div
      v-if="!loading && !hasError && total > items.length"
      class="border-t px-2.5 py-1.5 text-[11px] text-muted-foreground"
    >
      还有 {{ total - items.length }} 项，继续输入以精确匹配
    </div>
  </div>
</template>
