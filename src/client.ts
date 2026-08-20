/**
 * Browser half of the kanban plugin.
 *
 * - mounts the `kanban` Typert Remote contribution (`ctx.remote.$mount`),
 * - registers a sidebar footer action (the「任务看板」entry),
 * - registers a frame-wide `shell.overlay` panel that mounts the shadcn-vue
 *   kanban app (see `./kanban-entry`).
 */
import * as React from 'react';
import { createElement, useEffect, useRef, useSyncExternalStore } from 'react';
import { KANBAN_REMOTE } from './remote';
import { mountKanban } from './kanban-entry';
import type { KanbanApi } from './lib/bridge';
import kanbanCss from './assets/index.css?inline';
import sonnerCss from 'vue-sonner/style.css?inline';

// ── CSS injection (matches the DSH `<style data-plugin-css>` pattern) ───────
function injectStyles() {
  const css = kanbanCss + '\n' + sonnerCss;
  const tagId = '@deepseek-kanban/plugin/kanban.css';
  if (typeof document !== 'undefined' && !document.querySelector(`style[data-plugin-css="${tagId}"]`)) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@deepseek-kanban/plugin';
    tag.dataset.pluginCss = tagId;
    tag.textContent = css;
    document.head.appendChild(tag);
  }
}

// ── tiny overlay open/closed store shared by the two slots ──────────────────
let overlayOpen = false;
const storeListeners = new Set<() => void>();
function getOverlayOpen() {
  return overlayOpen;
}
function setOverlayOpen(v: boolean) {
  overlayOpen = v;
  storeListeners.forEach((l) => l());
}
function subscribeStore(l: () => void) {
  storeListeners.add(l);
  return () => {
    storeListeners.delete(l);
  };
}

// ── toggle hotkey (Ctrl+K / Cmd+K) ──────────────────────────────────────────
let toggleHotkeyCleanup: (() => void) | null = null;
function setupToggleHotkey(): void {
  toggleHotkeyCleanup?.();
  const onKeydown = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey || e.shiftKey) return;
    if (e.key.toLowerCase() !== 'k') return;
    e.preventDefault();
    e.stopPropagation();
    setOverlayOpen(!getOverlayOpen());
  };
  window.addEventListener('keydown', onKeydown, true);
  toggleHotkeyCleanup = () => window.removeEventListener('keydown', onKeydown, true);
}

// ── sidebar footer action ───────────────────────────────────────────────────
function BoardIcon() {
  return createElement(
    'svg',
    {
      width: 16,
      height: 16,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    },
    createElement('rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }),
    createElement('path', { d: 'M3 9h18' }),
    createElement('path', { d: 'M9 21V9' }),
  );
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
const HOTKEY_LABEL = IS_MAC ? '⌘K' : 'Ctrl+K';

function SidebarKanbanMenu(props: { wide: boolean; onOpen: () => void }) {
  const wide = props.wide;
  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: wide ? '100%' : 'auto',
    padding: wide ? '6px 8px' : '6px',
    borderRadius: 8,
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    color: 'inherit',
    fontSize: 14,
    justifyContent: wide ? 'flex-start' : 'center',
  };
  const kbdStyle: React.CSSProperties = {
    marginLeft: 'auto',
    fontSize: 11,
    lineHeight: 1,
    padding: '3px 6px',
    borderRadius: 6,
    border: '1px solid var(--dsw-alias-border, rgba(0,0,0,0.15))',
    background: 'var(--dsw-alias-fill-subtle, rgba(0,0,0,0.05))',
    color: 'var(--dsw-alias-label-tertiary, #666)',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
    opacity: 0.85,
  };
  return createElement(
    'button',
    {
      type: 'button',
      style: rowStyle,
      onClick: props.onOpen,
      title: `任务看板（${HOTKEY_LABEL}）`,
      'aria-label': `任务看板（${HOTKEY_LABEL}）`,
    },
    createElement(BoardIcon),
    wide ? createElement('span', null, '任务看板') : null,
    wide ? createElement('kbd', { style: kbdStyle }, HOTKEY_LABEL) : null,
  );
}

// ── shell overlay panel (mounts the Vue app) ────────────────────────────────
function KanbanOverlay(props: { kanbanApi: KanbanApi }) {
  const open = useSyncExternalStore(subscribeStore, getOverlayOpen);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef(props.kanbanApi);
  apiRef.current = props.kanbanApi;

  useEffect(() => {
    const el = hostRef.current;
    if (!el || !open) return;
    const dispose = mountKanban(el, apiRef.current);
    return () => {
      dispose();
    };
  }, [open]);

  if (!open) return null;

  const backdropStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.45)',
    pointerEvents: 'auto',
    display: 'flex',
    alignItems: 'stretch',
    justifyContent: 'stretch',
    padding: '24px',
    zIndex: 10000,
  };
  const panelStyle: React.CSSProperties = {
    flex: 1,
    background: 'var(--dsw-alias-panel-fill, #fff)',
    color: 'var(--dsw-alias-label-primary, #111)',
    borderRadius: 12,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
  };

  return createElement(
    'div',
    { style: backdropStyle, onClick: (e: any) => e.target === e.currentTarget && setOverlayOpen(false) },
    createElement('div', { style: panelStyle, onClick: (e: any) => e.stopPropagation() },
      createElement('div', { ref: hostRef, style: { flex: 1, minHeight: 0 } }),
    ),
  );
}

// ── plugin entry ────────────────────────────────────────────────────────────
export const inject = ['slots', 'remote'];

export async function apply(ctx: any) {
  injectStyles();
  setupToggleHotkey();
  const remote = ctx.get('remote');
  await remote.$mount(KANBAN_REMOTE);
  const kanbanApi = ctx.get('remote.kanban');

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'kanban',
        order: 50,
        inject: () => ({ onOpen: () => setOverlayOpen(true) }),
      },
      SidebarKanbanMenu as any,
    ),
  );

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'kanban',
        order: 50,
        inject: () => ({ kanbanApi }),
      },
      KanbanOverlay as any,
    ),
  );
}
