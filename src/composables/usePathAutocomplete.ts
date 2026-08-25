/**
 * usePathAutocomplete — "/" 触发的项目目录路径补全。
 *
 * 支持两类可编辑元素：
 *   - <textarea>：selectionStart/selectionEnd、value、mirror div 测光标；
 *   - contenteditable div（WYSIWYG 编辑器）：innerText、Selection/Range、
 *     range.getClientRects() 测光标、execCommand/insertNode 插入。
 *
 * 在输入 "/"（且该 "/" 位于一个以空白分隔的词的起始位置）时，
 * 会基于当前项目（resolvePaths 提供）的文件/目录树弹出补全列表，支持：
 *   - 目录前缀导航："/src/" 只展示 src 的直接子项；
 *   - 键盘操作：↑/↓ 移动、Enter/Tab 选中、Esc 关闭；
 *   - 目录选中后自动追加 "/" 并继续展示其子项；
 *   - 光标跟随定位、滚动/缩放时重定位。
 */
import { nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import type { ComponentPublicInstance } from 'vue';

export interface PathSuggestionItem {
  /** 相对项目根目录的路径（不含前导 "/"），如 "src/components"。 */
  path: string;
  isDir: boolean;
}

export interface PathAutocompleteOptions {
  /** textarea 元素或其组件实例（用于解析 $el）。 */
  element: { value: HTMLElement | ComponentPublicInstance | null | undefined };
  /** 绑定的文本模型（可写 ref / 可写 computed）。 */
  model: { value: string };
  /** 解析当前上下文可用路径列表。 */
  resolvePaths: () => Promise<string[]> | string[];
  /** 路径列表的缓存 key；返回 null/undefined 时禁用补全。 */
  cacheKey: () => string | null;
  /** 列表最大展示条数。 */
  maxResults?: number;
  /** 浮层定位容器（默认 textarea 的 parentElement；编辑器内部 DOM 多层时需显式指定）。 */
  positionContainer?: { value: HTMLElement | null | undefined };
}

interface PathCacheEntry {
  paths: string[];
  dirs: Set<string>;
}

/** 模块级路径缓存，跨组件复用（同一项目只拉取一次）。 */
const pathsCache = new Map<string, PathCacheEntry>();
const pendingLoads = new Map<string, Promise<PathCacheEntry>>();

const CARET_STYLE_PROPS = [
  'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
  'fontStretch', 'letterSpacing', 'wordSpacing', 'lineHeight',
  'textAlign', 'textIndent', 'textTransform', 'whiteSpace', 'wordWrap',
  'wordBreak', 'tabSize',
] as const;

/** 所有路径的祖先目录集合（目录在树中存在的判定）。 */
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

/**
 * 过滤逻辑：查询串以最后一个 "/" 为分界，前半部分为目录前缀（只展示其直接子项），
 * 后半部分为名称前缀（不区分大小写）。目录优先排序。
 */
function filterPaths(paths: string[], dirs: Set<string>, q: string): PathSuggestionItem[] {
  const slashIdx = q.lastIndexOf('/');
  const dirPrefix = slashIdx >= 0 ? q.slice(0, slashIdx + 1) : '';
  const namePrefix = (slashIdx >= 0 ? q.slice(slashIdx + 1) : q).toLowerCase();
  const matched = paths
    .filter((p) => p.startsWith(dirPrefix) && !p.slice(dirPrefix.length).includes('/'))
    .filter((p) => p.slice(dirPrefix.length).toLowerCase().startsWith(namePrefix))
    .sort((a, b) => {
      const ad = dirs.has(a) ? 0 : 1;
      const bd = dirs.has(b) ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.localeCompare(b);
    });
  return matched.map((p) => ({ path: p, isDir: dirs.has(p) }));
}

/** 解析触发词：从光标向前回溯到最近空白，token 需以 "/" 开头。 */
function parseTrigger(value: string, caret: number): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') break;
    i -= 1;
  }
  const start = i + 1;
  if (value[start] !== '/') return null;
  return { start, query: value.slice(start + 1, caret) };
}

function loadEntry(key: string, resolvePaths: () => Promise<string[]> | string[]): Promise<PathCacheEntry> {
  const cached = pathsCache.get(key);
  if (cached) return Promise.resolve(cached);
  let pending = pendingLoads.get(key);
  if (!pending) {
    pending = Promise.resolve(resolvePaths()).then((raw) => {
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

/** 给加载操作加超时兜底：远程调用万一挂起，也能明确报错而不是无限转圈。 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** 判断可编辑元素是否为 textarea。 */
function isTextarea(el: HTMLElement): el is HTMLTextAreaElement {
  return el instanceof HTMLTextAreaElement;
}

/** 读取可编辑元素的纯文本（contenteditable 的 innerText 尾随换行需要去掉）。 */
function getValue(el: HTMLElement): string {
  return isTextarea(el) ? el.value : (el.innerText ?? '').replace(/\n+$/, '');
}

/** 光标在纯文本中的字符偏移。 */
function getCaret(el: HTMLElement): number {
  if (isTextarea(el)) return el.selectionStart ?? getValue(el).length;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return getValue(el).length;
  const range = sel.getRangeAt(0);
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

/** 把字符偏移转成内容里的 Range（供 contenteditable 定位）。 */
function rangeFromOffset(el: HTMLElement, offset: number): Range {
  const range = document.createRange();
  if (offset <= 0) {
    range.setStart(el, 0);
    range.collapse(true);
    return range;
  }
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    if (remaining <= t.data.length) {
      range.setStart(t, remaining);
      range.collapse(true);
      return range;
    }
    remaining -= t.data.length;
  }
  range.selectNodeContents(el);
  range.collapse(false);
  return range;
}

/** 把 selection 设到内容第 offset 个字符处。 */
function setCaret(el: HTMLElement, offset: number) {
  if (isTextarea(el)) {
    el.focus();
    el.setSelectionRange(offset, offset);
    return;
  }
  const range = rangeFromOffset(el, offset);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

/** 删除内容 [start, end) 并插入 insert 文本，光标停在插入文本末尾。 */
function spliceText(el: HTMLElement, start: number, end: number, insert: string) {
  if (isTextarea(el)) {
    const next = getValue(el);
    const value = next.slice(0, start) + insert + next.slice(end);
    el.value = value;
    el.focus();
    el.setSelectionRange(start + insert.length, start + insert.length);
    return value;
  }
  const sel = window.getSelection();
  if (!sel) return getValue(el);
  const range = document.createRange();
  const startRange = rangeFromOffset(el, start);
  const endRange = rangeFromOffset(el, end);
  range.setStart(startRange.startContainer, startRange.startOffset);
  range.setEnd(endRange.startContainer, endRange.startOffset);
  range.deleteContents();
  const node = document.createTextNode(insert);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  el.focus();
  return getValue(el);
}

export function usePathAutocomplete(options: PathAutocompleteOptions) {
  const { element, model, resolvePaths, cacheKey, maxResults = 20 } = options;
  const open = ref(false);
  const loading = ref(false);
  const hasError = ref(false);
  const items = ref<PathSuggestionItem[]>([]);
  const activeIndex = ref(0);
  const position = ref({ top: 0, left: 0 });
  const query = ref('');
  const total = ref(0);

  let attachedEl: HTMLElement | null = null;
  let tokenStart = -1;
  let refreshSeq = 0;

  function resolveElement(): HTMLElement | null {
    const raw = element.value;
    if (!raw) return null;
    const root = '$el' in raw ? raw.$el : raw;
    if (root instanceof HTMLTextAreaElement) return root;
    if (root instanceof HTMLElement && root.isContentEditable) return root;
    return null;
  }

  /** 用 mirror div 测量 textarea 光标像素位置；contenteditable 用 Selection rect。 */
  function caretCoordinates(el: HTMLElement, pos: number) {
    if (!isTextarea(el)) {
      const sel = window.getSelection();
      const elRect = el.getBoundingClientRect();
      if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
        const range = sel.getRangeAt(0);
        const rects = range.getClientRects();
        const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
        if (rects.length > 0) {
          const r = rects[0];
          return {
            left: r.left - elRect.left - el.scrollLeft,
            top: r.top - elRect.top - el.scrollTop,
            height: r.height || lineHeight,
          };
        }
        // 退化 rect 兜底：用焦点节点所在行的 rect
        const start = range.startContainer;
        if (start instanceof Element) {
          const sRect = start.getBoundingClientRect();
          return {
            left: sRect.left - elRect.left - el.scrollLeft,
            top: sRect.top - elRect.top - el.scrollTop,
            height: lineHeight,
          };
        }
      }
      const wrap = el.parentElement as HTMLElement | null;
      const wrapRect = wrap?.getBoundingClientRect() ?? elRect;
      return { left: 4, top: 4, height: 20, wrapRect };
    }
    const mirror = document.createElement('div');
    const computed = window.getComputedStyle(el);
    for (const p of CARET_STYLE_PROPS) {
      (mirror.style as Record<string, string>)[p] = computed[p];
    }
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.top = '0';
    mirror.style.left = '-9999px';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    // clientWidth 不含滚动条，与 textarea 的实际换行宽度一致。
    mirror.style.width = `${el.clientWidth}px`;

    const value = el.value.slice(0, pos);
    mirror.textContent = value.endsWith('\n') ? value + '\u200b' : value;
    const span = document.createElement('span');
    span.textContent = '\u200b';
    mirror.appendChild(span);

    document.body.appendChild(mirror);
    const spanRect = span.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();
    document.body.removeChild(mirror);

    return {
      left: spanRect.left - mirrorRect.left,
      top: spanRect.top - mirrorRect.top,
      height: spanRect.height || parseFloat(computed.lineHeight) || 20,
    };
  }

  /** 把浮层定位到光标下方（相对定位容器，默认 textarea 的父元素）。 */
  function updatePosition() {
    const el = attachedEl;
    const wrap = options.positionContainer?.value ?? el?.parentElement as HTMLElement | null;
    if (!el || !wrap) return;
    const caret = getCaret(el);
    const coords = caretCoordinates(el, caret);
    const x = coords.left - el.scrollLeft;
    const y = coords.top - el.scrollTop;
    // 光标滚出可视区域时收起浮层。
    if (y < -coords.height || y > el.clientHeight) {
      open.value = false;
      return;
    }
    const elRect = el.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const width = 288;
    position.value = {
      top: (elRect.top - wrapRect.top) + y + coords.height + 6,
      left: Math.max(4, Math.min((elRect.left - wrapRect.left) + x, Math.max(4, wrapRect.width - width))),
    };
  }

  function applyMatches(entry: PathCacheEntry, q: string) {
    const matched = filterPaths(entry.paths, entry.dirs, q);
    total.value = matched.length;
    items.value = matched.slice(0, maxResults);
    activeIndex.value = 0;
  }

  async function refresh() {
    const el = attachedEl;
    if (!el) return;
    if (el !== document.activeElement) {
      close();
      return;
    }
    const caret = getCaret(el);
    const trigger = parseTrigger(getValue(el), caret);
    const key = cacheKey();
    if (!trigger || key === null || key === undefined) {
      close();
      return;
    }
    const seq = ++refreshSeq;
    tokenStart = trigger.start;
    query.value = trigger.query;
    open.value = true;
    updatePosition();

    const cached = pathsCache.get(key);
    if (cached) {
      applyMatches(cached, trigger.query);
      return;
    }
    loading.value = true;
    hasError.value = false;
    try {
      const entry = await withTimeout(loadEntry(key, resolvePaths), 8000, '加载项目目录超时');
      if (seq !== refreshSeq) return;
      applyMatches(entry, trigger.query);
    } catch {
      if (seq !== refreshSeq) return;
      hasError.value = true;
      items.value = [];
      total.value = 0;
      activeIndex.value = 0;
    } finally {
      loading.value = false;
    }
  }

  function select(index: number) {
    const el = attachedEl;
    const item = items.value[index];
    if (!el || !item) return;
    const caret = getCaret(el);
    const tail = item.isDir ? '/' : '';
    const insert = `/${item.path}${tail}`;
    const value = spliceText(el, tokenStart, caret, insert);
    const newCaret = tokenStart + insert.length;
    tokenStart = -1;
    open.value = false;
    model.value = value;
    void nextTick(() => {
      const current = attachedEl;
      if (!current) return;
      setCaret(current, newCaret);
      // 选中目录后立即展示其子项，形成连续导航。
      if (item.isDir) void refresh();
    });
  }

  function close() {
    // 关闭时同时重置 loading/hasError/items，避免下次 mount 时残留「正在加载」状态。
    open.value = false;
    loading.value = false;
    hasError.value = false;
    items.value = [];
    activeIndex.value = 0;
    total.value = 0;
    query.value = '';
    // 提鲜 refreshSeq，让任何在途的 refresh 提前返回（finally 仍会执行，但 items 不会写入）。
    refreshSeq += 1;
  }

  function setActive(index: number) {
    if (index >= 0 && index < items.value.length) activeIndex.value = index;
  }

  function handleInput(e: Event) {
    if ((e as InputEvent).isComposing) return;
    void refresh();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.isComposing || !open.value) return;
    const len = items.value.length;
    if (len === 0) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        activeIndex.value = (activeIndex.value + 1) % len;
        break;
      case 'ArrowUp':
        e.preventDefault();
        activeIndex.value = (activeIndex.value - 1 + len) % len;
        break;
      case 'Enter':
      case 'Tab':
        e.preventDefault();
        e.stopPropagation();
        select(activeIndex.value);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
    }
  }

  function handleClick() {
    // 点击（含点击已有文本中的 "/" token）不应主动弹出补全——
    // 只有用户实际输入（input 事件）才触发打开；点击仅让已打开的浮层跟随光标重定位。
    if (open.value) updatePosition();
  }

  function handleBlur() {
    close();
  }

  function handleViewportChange() {
    if (open.value) updatePosition();
  }

  function detach() {
    if (!attachedEl) return;
    attachedEl.removeEventListener('input', handleInput);
    attachedEl.removeEventListener('keydown', handleKeydown);
    attachedEl.removeEventListener('click', handleClick);
    attachedEl.removeEventListener('blur', handleBlur);
    attachedEl = null;
  }

  function attach() {
    detach();
    const el = resolveElement();
    if (!el) {
      close();
      return;
    }
    attachedEl = el;
    el.addEventListener('input', handleInput);
    el.addEventListener('keydown', handleKeydown);
    el.addEventListener('click', handleClick);
    el.addEventListener('blur', handleBlur);
  }

  watch(() => element.value, attach, { flush: 'post' });
  // 模型被清空时（如提交后重置、切换任务）强制收起浮层，避免残留。
  watch(() => model.value, (value) => {
    if (!value) close();
  });
  window.addEventListener('scroll', handleViewportChange, true);
  window.addEventListener('resize', handleViewportChange);
  onBeforeUnmount(() => {
    detach();
    window.removeEventListener('scroll', handleViewportChange, true);
    window.removeEventListener('resize', handleViewportChange);
  });

  // 注意：必须用 reactive 包装返回对象。若返回普通对象，`pathSuggest.open` 在
  // 父组件模板中不会被 Vue 自动解包（普通对象里的 ref 不解包），会以 RefImpl 对象
  // 传入 PathSuggestionList 的 `open: {type: Boolean}` prop，经 Boolean(RefImpl) 后
  // 恒为 true，导致「空白也弹窗 + 一直显示加载中」。reactive 会自动解包 ref 属性，
  // 使 open/loading 等在模板中成为真正的 boolean。
  return reactive({
    open,
    loading,
    hasError,
    items,
    activeIndex,
    position,
    query,
    total,
    select,
    setActive,
    close,
    refresh,
  });
}
