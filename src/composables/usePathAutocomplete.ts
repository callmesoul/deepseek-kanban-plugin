/**
 * usePathAutocomplete — "/" 触发的项目目录路径补全。
 *
 * 在 textarea 中输入 "/"（且该 "/" 位于一个以空白分隔的词的起始位置）时，
 * 会基于当前项目（resolvePaths 提供）的文件/目录树弹出补全列表，支持：
 *   - 目录前缀导航："/src/" 只展示 src 的直接子项；
 *   - 键盘操作：↑/↓ 移动、Enter/Tab 选中、Esc 关闭；
 *   - 目录选中后自动追加 "/" 并继续展示其子项；
 *   - 光标跟随定位（mirror div 测量）、滚动/缩放时重定位。
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
// eslint-disable-next-line no-console
const debug = (label: string, data?: unknown) => console.warn(`[path-autocomplete] ${label}`, data);
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

  // 追踪 open 的每一次变化，定位“状态自认为关闭但浮层仍显示”的问题。
  watch(open, (value, oldValue) => {
    // eslint-disable-next-line no-console
    console.warn('[path-autocomplete] open changed', { value, oldValue, stack: new Error().stack?.split('\n').slice(2, 8).join(' | ') });
  }, { immediate: true });

  let attachedEl: HTMLTextAreaElement | null = null;
  let tokenStart = -1;
  let refreshSeq = 0;

  function resolveElement(): HTMLTextAreaElement | null {
    const raw = element.value;
    if (!raw) return null;
    const root = '$el' in raw ? raw.$el : raw;
    return root instanceof HTMLTextAreaElement ? root : null;
  }

  /** 用 mirror div 测量光标在 textarea 内的像素位置（含 padding、随滚动位移）。 */
  function caretCoordinates(el: HTMLTextAreaElement, pos: number) {
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

  /** 把浮层定位到光标下方（相对 textarea 的 relative 父容器）。 */
  function updatePosition() {
    const el = attachedEl;
    const wrap = el?.parentElement as HTMLElement | null;
    if (!el || !wrap) return;
    const caret = el.selectionStart ?? el.value.length;
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
    // eslint-disable-next-line no-console
    console.warn('[path-autocomplete] refresh called', {
      hasEl: !!el,
      active: el === document.activeElement,
      value: el?.value,
      caret: el?.selectionStart,
      open: open.value,
      loading: loading.value,
    });
    if (!el) return;
    if (el !== document.activeElement) {
      close();
      return;
    }
    const caret = el.selectionStart ?? el.value.length;
    const trigger = parseTrigger(el.value, caret);
    const key = cacheKey();
    // eslint-disable-next-line no-console
    console.warn('[path-autocomplete] trigger parse', { trigger, key });
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
      // eslint-disable-next-line no-console
      console.warn('[path-autocomplete] loading paths for', key);
      const entry = await withTimeout(loadEntry(key, resolvePaths), 8000, '加载项目目录超时');
      // eslint-disable-next-line no-console
      console.warn('[path-autocomplete] loaded', { key, seq, refreshSeq, pathsCount: entry.paths.length });
      if (seq !== refreshSeq) return;
      applyMatches(entry, trigger.query);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[path-autocomplete] load error', err);
      if (seq !== refreshSeq) return;
      hasError.value = true;
      items.value = [];
      total.value = 0;
      activeIndex.value = 0;
    } finally {
      loading.value = false;
      // eslint-disable-next-line no-console
      console.warn('[path-autocomplete] loading finished', { loading: loading.value, open: open.value });
    }
  }

  function select(index: number) {
    const el = attachedEl;
    const item = items.value[index];
    if (!el || !item) return;
    const caret = el.selectionStart ?? el.value.length;
    const tail = item.isDir ? '/' : '';
    const insert = `/${item.path}${tail}`;
    const newValue = el.value.slice(0, tokenStart) + insert + el.value.slice(caret);
    const newCaret = tokenStart + insert.length;
    tokenStart = -1;
    open.value = false;
    model.value = newValue;
    void nextTick(() => {
      const current = attachedEl;
      if (!current) return;
      current.focus();
      current.setSelectionRange(newCaret, newCaret);
      // 选中目录后立即展示其子项，形成连续导航。
      if (item.isDir) void refresh();
    });
  }

  function close() {
    // eslint-disable-next-line no-console
    console.warn('[path-autocomplete] close called', { open: open.value });
    open.value = false;
  }

  function setActive(index: number) {
    if (index >= 0 && index < items.value.length) activeIndex.value = index;
  }

  function handleInput(e: Event) {
    // eslint-disable-next-line no-console
    console.warn('[path-autocomplete] input event', { value: (e.target as HTMLTextAreaElement)?.value, isComposing: (e as InputEvent).isComposing });
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
    // eslint-disable-next-line no-console
    console.warn('[path-autocomplete] click event', { open: open.value });
    // 点击（含点击已有文本中的 "/" token）不应主动弹出补全——
    // 只有用户实际输入（input 事件）才触发打开；点击仅让已打开的浮层跟随光标重定位。
    if (open.value) updatePosition();
  }

  function handleBlur() {
    // eslint-disable-next-line no-console
    console.warn('[path-autocomplete] blur event', { open: open.value });
    close();
  }

  function handleViewportChange() {
    if (open.value) updatePosition();
  }

  function detach() {
    // eslint-disable-next-line no-console
    console.warn('[path-autocomplete] detach', { attached: !!attachedEl });
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
    // eslint-disable-next-line no-console
    console.warn('[path-autocomplete] attach', { hasEl: !!el });
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

  watch(() => element.value, (val, oldVal) => {
    // eslint-disable-next-line no-console
    console.warn('[path-autocomplete] element changed', { hasValue: !!val, hadValue: !!oldVal });
    attach();
  }, { flush: 'post' });
  // 模型被清空时（如提交后重置、切换任务）强制收起浮层，避免残留。
  watch(() => model.value, (value) => {
    // eslint-disable-next-line no-console
    console.warn('[path-autocomplete] model changed', { value, open: open.value });
    if (!value) close();
  });
  window.addEventListener('scroll', handleViewportChange, true);
  window.addEventListener('resize', handleViewportChange);
  onBeforeUnmount(() => {
    detach();
    window.removeEventListener('scroll', handleViewportChange, true);
    window.removeEventListener('resize', handleViewportChange);
  });

  return {
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
  };
}
