/**
 * markdown.ts — 统一的 Markdown 渲染入口（marked + DOMPurify）。
 *
 * 所有需要渲染 markdown 的地方（MarkdownPreview、MarkdownEditor）都从这里取，
 * 保证配置一致：GFM + breaks（换行即换行），外链自动新窗口打开。
 */
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

/** 把 Markdown 源文本渲染为经过白名单清洗的 HTML。空文本返回空串。 */
export function renderMarkdown(text: string): string {
  const value = text ?? '';
  if (!value.trim()) return '';
  const raw = marked.parse(value) as string;
  // 保留任务列表 checkbox 与链接属性，其余一律按 DOMPurify 默认白名单。
  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ['type', 'checked', 'disabled', 'target', 'rel'],
  });
}
