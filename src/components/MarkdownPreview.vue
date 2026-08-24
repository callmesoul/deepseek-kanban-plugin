<script setup lang="ts">
/**
 * MarkdownPreview — 安全渲染 Markdown 文本。
 *
 * 解析用 marked（GFM + 换行即换行），输出经 DOMPurify 白名单清洗后再注入，
 * 外链自动新窗口打开。样式跟随 .dsh-kanban-root 的设计令牌，明暗主题自适应。
 */
import { computed } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// 统一解析配置：GFM（表格/任务列表/删除线）+ breaks（贴合聊天/评论输入习惯）。
marked.use({ gfm: true, breaks: true, async: false });

// 外链新窗口打开且不泄露 opener；模块级只注册一次，防 HMR 叠加。
const HOOK_FLAG = '__dshKanbanMdHook__';
if (!(DOMPurify as unknown as Record<string, unknown>)[HOOK_FLAG]) {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? '';
      if (/^(?:https?:)?\/\//i.test(href)) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
  });
  (DOMPurify as unknown as Record<string, unknown>)[HOOK_FLAG] = true;
}

const props = defineProps<{
  /** Markdown 源文本 */
  content: string;
  /** 空内容时的占位提示 */
  placeholder?: string;
}>();

const html = computed(() => {
  const text = props.content ?? '';
  if (!text.trim()) return '';
  // marked 默认同步模式（async: false），返回 string。
  const raw = marked.parse(text) as string;
  // 保留任务列表 checkbox 与链接属性，其余一律按 DOMPurify 默认白名单。
  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ['type', 'checked', 'disabled', 'target', 'rel'],
  });
});
</script>

<template>
  <div v-if="html" class="markdown-body" v-html="html" />
  <p v-else class="text-sm text-muted-foreground">
    {{ placeholder ?? '（无内容）' }}
  </p>
</template>

<style scoped>
.markdown-body {
  font-size: 0.875rem;
  line-height: 1.75;
  color: var(--foreground);
  overflow-wrap: break-word;
}

.markdown-body :deep(p) {
  margin: 0.5em 0;
}
.markdown-body :deep(p:first-child) {
  margin-top: 0;
}
.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4),
.markdown-body :deep(h5),
.markdown-body :deep(h6) {
  margin: 0.9em 0 0.4em;
  font-weight: 600;
  line-height: 1.4;
}
.markdown-body :deep(h1) {
  font-size: 1.25rem;
}
.markdown-body :deep(h2) {
  font-size: 1.125rem;
}
.markdown-body :deep(h3) {
  font-size: 1rem;
}
.markdown-body :deep(h4) {
  font-size: 0.9rem;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 0.5em 0;
  padding-left: 1.4em;
}
.markdown-body :deep(ul) {
  list-style: disc;
}
.markdown-body :deep(ol) {
  list-style: decimal;
}
.markdown-body :deep(li) {
  margin: 0.2em 0;
}
.markdown-body :deep(li > ul),
.markdown-body :deep(li > ol) {
  margin: 0.2em 0;
  padding-left: 1.2em;
}

.markdown-body :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 0.8125em;
  background: var(--muted);
  border-radius: calc(var(--radius) - 4px);
  padding: 0.15em 0.4em;
}

.markdown-body :deep(pre) {
  margin: 0.6em 0;
  padding: 0.75em 1em;
  background: var(--muted);
  border-radius: var(--radius);
  overflow-x: auto;
  line-height: 1.6;
}
.markdown-body :deep(pre code) {
  background: transparent;
  padding: 0;
  font-size: 0.8125em;
}

.markdown-body :deep(blockquote) {
  margin: 0.6em 0;
  padding: 0.15em 0 0.15em 0.9em;
  border-left: 3px solid var(--border);
  color: var(--muted-foreground);
}
.markdown-body :deep(blockquote p) {
  margin: 0.3em 0;
}

.markdown-body :deep(a) {
  color: var(--primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.markdown-body :deep(table) {
  width: 100%;
  margin: 0.5em 0;
  border-collapse: collapse;
  font-size: 0.875rem;
}
.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--border);
  padding: 0.4em 0.6em;
  text-align: left;
}
.markdown-body :deep(th) {
  background: var(--muted);
  font-weight: 600;
}

.markdown-body :deep(hr) {
  margin: 1em 0;
  border: 0;
  border-top: 1px solid var(--border);
}

.markdown-body :deep(img) {
  max-width: 100%;
  border-radius: var(--radius);
}

.markdown-body :deep(input[type='checkbox']) {
  margin-right: 0.4em;
  vertical-align: -0.15em;
  accent-color: var(--primary);
}

.markdown-body :deep(strong) {
  font-weight: 600;
}
.markdown-body :deep(del) {
  color: var(--muted-foreground);
}
</style>
