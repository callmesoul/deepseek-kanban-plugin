<script setup lang="ts">
/**
 * MarkdownPreview — 安全渲染 Markdown 文本（只读展示）。
 * 渲染逻辑与排版样式分别在 src/lib/markdown.ts 与全局 .markdown-body。
 */
import { computed } from 'vue';
import { renderMarkdown } from '@/lib/markdown';

const props = defineProps<{
  /** Markdown 源文本 */
  content: string;
  /** 空内容时的占位提示 */
  placeholder?: string;
}>();

const html = computed(() => renderMarkdown(props.content ?? ''));
</script>

<template>
  <div v-if="html" class="markdown-body" v-html="html" />
  <p v-else class="text-sm text-muted-foreground">
    {{ placeholder ?? '（无内容）' }}
  </p>
</template>
