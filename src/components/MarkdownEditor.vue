<script setup lang="ts">
/**
 * MarkdownEditor — 基于 md-editor-v3 的 Markdown 编辑器。
 *
 * 左侧源码编辑 + 右侧实时预览；明暗主题随 .dsh-kanban-root.dark 自动切换。
 * "/" 路径补全基于 md-editor-v3 暴露的 CodeMirror EditorView（v6 编辑区不是
 * textarea，不能用 usePathAutocomplete）：view.state.doc 读文本、
 * view.state.selection.main.head 读光标、view.dispatch 插入、coordsAtPos 定位。
 */
import { computed, ref } from 'vue';
import type { ComponentPublicInstance } from 'vue';
import { MdEditor } from 'md-editor-v3';
import mdEditorCss from 'md-editor-v3/lib/style.css?inline';
import type { EditorView } from '@codemirror/view';
import PathSuggestionList from './PathSuggestionList.vue';
import type { PathSuggestionItem } from '@/composables/usePathAutocomplete';

// md-editor-v3 样式注入（模块级一次，防 HMR 叠加）
const MD_CSS_ID = '@deepseek-kanban/md-editor-v3';
if (typeof document !== 'undefined' && !document.querySelector(`style[data-css="${MD_CSS_ID}"]`)) {
  const style = document.createElement('style');
  style.setAttribute('data-css', MD_CSS_ID);
  style.textContent = mdEditorCss;
  document.head.appendChild(style);
}

const props = withDefaults(defineProps<{
  modelValue: string;
  placeholder?: string;
  disabled?: boolean;
  /** 解析当前上下文可用路径列表（"/" 补全用）。 */
  resolvePaths?: () => Promise<string[]> | string[];
  /** 路径列表缓存 key；返回 null/undefined 时禁用补全。 */
  cacheKey?: () => string | null;
  minHeight?: number;
}>(), {
  modelValue: '',
  placeholder: '',
  disabled: false,
  resolvePaths: undefined,
  cacheKey: undefined,
  minHeight: 240,
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const mdRef = ref<ComponentPublicInstance | null>(null);
const containerRef = ref<HTMLDivElement | null>(null);

/** 通过 md-editor-v3 暴露的 getEditorView() 拿 CodeMirror EditorView（兜底用 findFromDOM）。 */
function getView(): EditorView | null {
  const inst = mdRef.value as { getEditorView?: () => EditorView | null } | null;
  const v = inst?.getEditorView?.() ?? null;
  if (v) return v;
  // fallback：从 .cm-editor DOM 反查 EditorView 实例
  const cmEl = containerRef.value?.querySelector<HTMLElement>('.cm-editor');
  if (cmEl) {
    try {
      const found = EditorView.findFromDOM(cmEl);
      if (found) return found;
    } catch {
      /* 忽略 */
    }
  }
  return null;
}

// 明暗主题跟随 .dsh-kanban-root.dark
const isDark = ref(!!(typeof document !== 'undefined' && document.querySelector('.dsh-kanban-root.dark')));
let themeObserver: MutationObserver | null = null;
if (typeof document !== 'undefined') {
  const themeRoot = document.querySelector('.dsh-kanban-root');
  if (themeRoot) {
    themeObserver = new MutationObserver(() => {
      isDark.value = !!document.querySelector('.dsh-kanban-root.dark');
    });
    themeObserver.observe(themeRoot, { attributes: true, attributeFilter: ['class'] });
  }
}
const theme = computed(() => (isDark.value ? 'dark' : 'light'));

const textModel = computed<string>({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

// ── "/" 路径补全（CodeMirror 版）───────────────────────────────────────────
const suggestOpen = ref(false);
const suggestLoading = ref(false);
const suggestHasError = ref(false);
const suggestItems = ref<PathSuggestionItem[]>([]);
const suggestActive = ref(0);
const suggestPosition = ref({ top: 0, left: 0 });
const suggestTotal = ref(0);
const pathsCache = new Map<string, { paths: string[]; dirs: Set<string> }>();
const pendingLoads = new Map<string, Promise<{ paths: string[]; dirs: Set<string> }>>();
let tokenStart = -1;
let refreshSeq = 0;

function deriveDirs(paths: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const p of paths) {
    let idx = p.lastIndexOf('/');
    while (idx > 0) {
      dirs.add(p.slice(0, idx));
      idx = p.lastIndexOf('/', idx - 1);
    }
  }
  return dirs;
}

function filterPaths(paths: string[], dirs: Set<string>, q: string): PathSuggestionItem[] {
  const slashIdx = q.lastIndexOf('/');
  const dirPrefix = slashIdx >= 0 ? q.slice(0, slashIdx + 1) : '';
  const namePrefix = (slashIdx >= 0 ? q.slice(slashIdx + 1) : q).toLowerCase();
  return paths
    .filter((p) => p.startsWith(dirPrefix) && !p.slice(dirPrefix.length).includes('/'))
    .filter((p) => p.slice(dirPrefix.length).toLowerCase().startsWith(namePrefix))
    .sort((a, b) => {
      const ad = dirs.has(a) ? 0 : 1;
      const bd = dirs.has(b) ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.localeCompare(b);
    })
    .map((p) => ({ path: p, isDir: dirs.has(p) }));
}

function loadEntry(key: string): Promise<{ paths: string[]; dirs: Set<string> }> {
  const cached = pathsCache.get(key);
  if (cached) return Promise.resolve(cached);
  let pending = pendingLoads.get(key);
  if (!pending) {
    pending = Promise.resolve(props.resolvePaths?.() ?? []).then((raw) => {
      const entry = { paths: raw, dirs: deriveDirs(raw) };
      pathsCache.set(key, entry);
      return entry;
    });
    pendingLoads.set(key, pending);
    pending
      .finally(() => pendingLoads.delete(key))
      .catch(() => {});
  }
  return pending;
}

/** 在 doc 文本中检测光标前的 "/" token（输入单个 "/" 即触发，query 可为空显示全部）。 */
function detectToken(text: string, head: number): { start: number; token: string } | null {
  let i = head - 1;
  while (i >= 0 && !/[ \t\n]/.test(text[i])) i--;
  const start = i + 1;
  const token = text.slice(start, head);
  if (!token.startsWith('/')) return null;
  return { start, token };
}

function updateSuggestPosition() {
  const view = getView();
  const container = containerRef.value;
  if (!view || !container) return;
  const head = view.state.selection.main.head;
  const coords = view.coordsAtPos(head);
  const crect = container.getBoundingClientRect();
  if (coords) {
    suggestPosition.value = {
      top: coords.bottom - crect.top + 4,
      left: coords.left - crect.left,
    };
  }
}

async function refreshSuggest() {
  if (!props.cacheKey || !props.resolvePaths) return;
  const view = getView();
  const key = props.cacheKey();
  if (!view || key === null || key === undefined) {
    closeSuggest();
    return;
  }
  const text = view.state.doc.toString();
  const head = view.state.selection.main.head;
  const det = detectToken(text, head);
  if (!det) {
    closeSuggest();
    return;
  }
  tokenStart = det.start;
  const query = det.token.slice(1);
  const seq = ++refreshSeq;
  suggestOpen.value = true;
  updateSuggestPosition();
  const cached = pathsCache.get(key);
  if (cached) {
    suggestItems.value = filterPaths(cached.paths, cached.dirs, query);
    suggestTotal.value = suggestItems.value.length;
    suggestActive.value = 0;
    return;
  }
  suggestLoading.value = true;
  suggestHasError.value = false;
  try {
    const entry = await loadEntry(key);
    if (seq !== refreshSeq) return;
    suggestItems.value = filterPaths(entry.paths, entry.dirs, query);
    suggestTotal.value = suggestItems.value.length;
    suggestActive.value = 0;
  } catch {
    if (seq !== refreshSeq) return;
    suggestHasError.value = true;
    suggestItems.value = [];
    suggestTotal.value = 0;
    suggestActive.value = 0;
  } finally {
    suggestLoading.value = false;
  }
}

/** 用 CodeMirror dispatch 替换 [tokenStart, head) 为路径文本。 */
function insertPath(insert: string) {
  const view = getView();
  if (!view || tokenStart < 0) return;
  const head = view.state.selection.main.head;
  view.dispatch({
    changes: { from: tokenStart, to: head, insert },
  });
  closeSuggest();
}

function selectSuggest(index: number) {
  const item = suggestItems.value[index];
  if (!item) return;
  insertPath(`/${item.path}${item.isDir ? '/' : ''}`);
  if (item.isDir) {
    setTimeout(() => void refreshSuggest(), 60);
  }
}

function setActiveSuggest(index: number) {
  if (index >= 0 && index < suggestItems.value.length) suggestActive.value = index;
}

function closeSuggest() {
  suggestOpen.value = false;
  suggestLoading.value = false;
  suggestHasError.value = false;
  suggestItems.value = [];
  suggestActive.value = 0;
  suggestTotal.value = 0;
  tokenStart = -1;
  refreshSeq += 1;
}

function onKeydown(e: KeyboardEvent) {
  if (e.isComposing) return;
  if (suggestOpen.value) {
    const len = suggestItems.value.length;
    if (len > 0) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          e.stopPropagation();
          suggestActive.value = (suggestActive.value + 1) % len;
          return;
        case 'ArrowUp':
          e.preventDefault();
          e.stopPropagation();
          suggestActive.value = (suggestActive.value - 1 + len) % len;
          return;
        case 'Enter':
        case 'Tab':
          e.preventDefault();
          e.stopPropagation();
          selectSuggest(suggestActive.value);
          return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeSuggest();
      return;
    }
  }
  if (e.key === '/') {
    setTimeout(() => void refreshSuggest(), 30);
  }}

function onBlur() {
  setTimeout(() => {
    const active = document.activeElement;
    if (!active || !containerRef.value?.contains(active)) closeSuggest();
  }, 120);
}

// ── 粘贴附件（图片）──────────────────────────────────────────────────────────
/** 从剪贴板 File 对象中尽力还原完整路径。 */
async function resolveFilePath(file: File): Promise<string> {
  // Electron/部分桌面宿主：File 对象直接携带系统绝对路径。
  const abs = (file as File & { path?: string }).path;
  if (typeof abs === 'string' && abs.trim()) return abs.trim();
  // 拖拽文件夹场景：携带目录的相对路径。
  if (file.webkitRelativePath) return file.webkitRelativePath;
  // 标准浏览器剪贴板只有文件名：尝试在项目文件树中按文件名唯一匹配，得到相对完整路径。
  const name = file.name;
  if (!name) return '';
  if (props.cacheKey && props.resolvePaths) {
    const key = props.cacheKey();
    if (key !== null && key !== undefined) {
      try {
        const entry = await loadEntry(key);
        const matches = entry.paths.filter((p) => p.split('/').pop() === name);
        if (matches.length === 1) return matches[0];
      } catch {
        // 匹配失败则回退为文件名。
      }
    }
  }
  return name;
}

/** 以 badge 形式插入：文本显示文件名，URL 记录完整路径。 */
function insertFileBadge(path: string) {
  const view = getView();
  if (!view) return;
  const name = path.split(/[\\/]/).pop() || path;
  const label = name.replace(/[[\]]/g, '');
  const title = path.replace(/"/g, '').replace(/\s+/g, ' ').trim();
  const md = `[${label}](<file://${path}> "${title}")`;
  const pos = view.state.selection.main.head;
  view.dispatch({ changes: { from: pos, to: pos, insert: md } });
  view.focus();
}

async function onPaste(e: ClipboardEvent) {
  const data = e.clipboardData;
  if (!data) return;

  const files: File[] = [];
  if (data.items) {
    for (const item of Array.from(data.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  if (!files.length && data.files?.length) {
    files.push(...Array.from(data.files));
  }
  if (!files.length) return;

  e.preventDefault();
  e.stopPropagation();

  for (const file of files) {
    const path = await resolveFilePath(file);
    if (path) insertFileBadge(path);
  }
}

const toolbars = [
  'bold', 'italic', 'strike', '|',
  'title', 'quote', 'unorderedList', 'orderedList', 'task', '|',
  'code', 'inlineCode', 'link', 'table', '|',
  'preview', 'fullscreen',
];
</script>

<template>
  <div ref="containerRef" class="relative" @keydown.capture="onKeydown" @blur="onBlur" @paste.capture="onPaste">
    <MdEditor
      ref="mdRef"
      v-model="textModel"
      :theme="theme"
      :preview="true"
      :placeholder="placeholder"
      :read-only="disabled"
      :toolbars="toolbars"
      :min-height="minHeight"
      language="zh-CN"
    />
    <PathSuggestionList
      :open="suggestOpen"
      :loading="suggestLoading"
      :has-error="suggestHasError"
      :items="suggestItems"
      :active-index="suggestActive"
      :position="suggestPosition"
      :total="suggestTotal"
      @select="selectSuggest"
      @hover="setActiveSuggest"
    />
  </div>
</template>
