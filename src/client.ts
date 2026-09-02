/**
 * Browser half of the kanban plugin.
 *
 * - mounts the `kanban` Typert Remote contribution (`ctx.remote.$mount`),
 * - registers a sidebar footer action (the「任务看板」entry),
 * - registers a frame-wide `shell.overlay` panel that mounts the shadcn-vue
 *   kanban app (see `./kanban-entry`).
 */
import * as React from 'react';
import { createElement, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { KANBAN_REMOTE } from './remote';
import { mountKanban } from './kanban-entry';
import { mountUpdateNotifier } from './update-entry';
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
const VIRTUAL_KANBAN_WORKSPACE_ID = 'kanban:virtual-workspace';
const VIRTUAL_KANBAN_WORKSPACE_TITLE = '看板任务';
const TASK_SESSION_POLL_INTERVAL = 4_000;

type ObservableSnapshot<T> = {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
};

function isLegacyKanbanWorkspace(workspace: any): boolean {
  return typeof workspace?.title === 'string'
    && workspace.title.endsWith('看板任务')
    && String(workspace.path || '').split(/[\\/]/).some(
      (segment) => segment.endsWith('.kanban-worktrees'),
    );
}

function createVirtualWorkspaceSource(
  base: ObservableSnapshot<any>,
  kanbanApi: KanbanApi,
) {
  const listeners = new Set<() => void>();
  let sessionIds: string[] = [];
  let snapshot: any;
  let stopped = false;
  let pollTimer: number | null = null;

  const compose = () => {
    const current = base.getSnapshot();
    const realWorkspaces = (current.items || []).filter(
      (workspace: any) => !isLegacyKanbanWorkspace(workspace),
    );
    const virtualWorkspace = {
      workspaceId: VIRTUAL_KANBAN_WORKSPACE_ID,
      title: VIRTUAL_KANBAN_WORKSPACE_TITLE,
      path: '',
      sessionIds,
      createdAt: '1970-01-01T00:00:00.000Z',
      updatedAt: '1970-01-01T00:00:00.000Z',
    };
    snapshot = { ...current, items: [virtualWorkspace, ...realWorkspaces] };
  };

  const notify = () => {
    compose();
    listeners.forEach((listener) => listener());
  };

  const refreshTaskSessions = async () => {
    try {
      const result = await kanbanApi.listTaskSessions();
      if (result.ok) {
        const next = [...new Set(result.value.sessionIds.filter(Boolean))];
        if (next.length !== sessionIds.length || next.some((id, index) => id !== sessionIds[index])) {
          sessionIds = next;
          notify();
        }
      }
    } catch (error) {
      console.warn('kanban virtual workspace refresh failed:', error);
    } finally {
      if (!stopped) {
        pollTimer = window.setTimeout(refreshTaskSessions, TASK_SESSION_POLL_INTERVAL);
      }
    }
  };

  compose();
  const unsubscribeBase = base.subscribe(notify);
  void refreshTaskSessions();

  const source: ObservableSnapshot<any> = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const useWorkspaces = <T,>(selector: (state: any) => T): T => {
    const state = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
    return selector(state);
  };

  return {
    useWorkspaces,
    dispose() {
      stopped = true;
      unsubscribeBase();
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      listeners.clear();
    },
  };
}

function installVirtualKanbanWorkspace(ctx: any, kanbanApi: KanbanApi): () => void {
  const workspaces = ctx.get('workspaces');
  const projection = createVirtualWorkspaceSource(workspaces.list, kanbanApi);
  let stopped = false;
  let patched: {
    entry: any;
    originalInject: any;
    wrappedInject: (...args: any[]) => any;
  } | null = null;

  const reconcile = () => {
    if (stopped) return;
    const entries = ctx.slots.entries('sidebar.workspaces');
    if (patched && entries.includes(patched.entry)) return;
    patched = null;

    const original = entries.find(
      (entry: any) => entry.component
        && entry.children?.['sidebar.workspaces.directoryFlow'],
    );
    if (!original) return;

    const originalInject = original.inject;
    const wrappedInject = (...args: any[]) => {
      const injected = typeof originalInject === 'function' ? originalInject(...args) : {};
      return {
        ...injected,
        useWorkspaces: projection.useWorkspaces,
        startSession: (workspaceId?: string) => {
          if (workspaceId === VIRTUAL_KANBAN_WORKSPACE_ID) {
            setOverlayOpen(true);
            return;
          }
          injected.startSession?.(workspaceId);
        },
        renameWorkspace: (workspaceId: string, title: string) => (
          workspaceId === VIRTUAL_KANBAN_WORKSPACE_ID
            ? Promise.resolve()
            : injected.renameWorkspace?.(workspaceId, title)
        ),
        deleteWorkspace: (workspaceId: string) => (
          workspaceId === VIRTUAL_KANBAN_WORKSPACE_ID
            ? Promise.resolve()
            : injected.deleteWorkspace?.(workspaceId)
        ),
        insertWorkspaceBefore: (workspaceId: string, beforeWorkspaceId?: string) => (
          workspaceId === VIRTUAL_KANBAN_WORKSPACE_ID
            || beforeWorkspaceId === VIRTUAL_KANBAN_WORKSPACE_ID
            ? Promise.resolve()
            : injected.insertWorkspaceBefore?.(workspaceId, beforeWorkspaceId)
        ),
        insertSessionBefore: (
          workspaceId: string,
          sessionId: string,
          beforeSessionId?: string,
        ) => (
          workspaceId === VIRTUAL_KANBAN_WORKSPACE_ID
            ? Promise.resolve()
            : injected.insertSessionBefore?.(workspaceId, sessionId, beforeSessionId)
        ),
      };
    };

    original.inject = wrappedInject;
    patched = { entry: original, originalInject, wrappedInject };
  };

  const unsubscribe = ctx.slots.subscribe('sidebar.workspaces', () => queueMicrotask(reconcile));
  reconcile();

  return () => {
    stopped = true;
    unsubscribe();
    if (patched?.entry.inject === patched.wrappedInject) {
      patched.entry.inject = patched.originalInject;
    }
    projection.dispose();
  };
}

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
      'data-kanban-toggle': true,
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
  const [sidebarWidth, setSidebarWidth] = useState(0);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || !open) return;
    const dispose = mountKanban(el, apiRef.current);
    return () => {
      dispose();
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const node = hostRef.current;
    const overlayLayer = node?.closest('[data-shell-overlay]') as HTMLElement | null;
    const frame = overlayLayer?.parentElement ?? null;
    if (!frame) return;

    const measure = () => {
      const tracks = getComputedStyle(frame).gridTemplateColumns;
      const px = parseFloat(tracks);
      if (Number.isFinite(px) && px >= 0) setSidebarWidth(px);
    };
    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(frame);
    const mo = new MutationObserver(measure);
    mo.observe(frame, { attributes: true, attributeFilter: ['style'] });
    window.addEventListener('resize', measure);

    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const node = hostRef.current;
    const overlayLayer = node?.closest('[data-shell-overlay]') as HTMLElement | null;
    const frame = overlayLayer?.parentElement ?? null;
    const sidebarCol = frame?.firstElementChild as HTMLElement | null;
    if (!sidebarCol) return;

    const onSidebarClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && sidebarCol.contains(t) && !t.closest('[data-kanban-toggle]')) {
        setOverlayOpen(false);
      }
    };
    document.addEventListener('click', onSidebarClick, true);
    return () => document.removeEventListener('click', onSidebarClick, true);
  }, [open]);

  if (!open) return null;

  const panelStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: sidebarWidth,
    background: 'var(--dsw-alias-panel-fill, #fff)',
    color: 'var(--dsw-alias-label-primary, #111)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  };

  return createElement(
    'div',
    { style: panelStyle },
    createElement('div', { ref: hostRef, style: { flex: 1, minHeight: 0 } }),
  );
}

function UpdateNotifierSlot(props: { kanbanApi: KanbanApi }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef(props.kanbanApi);
  apiRef.current = props.kanbanApi;

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    return mountUpdateNotifier(el, apiRef.current);
  }, []);

  return createElement('div', {
    ref: hostRef,
    style: { position: 'absolute', width: 0, height: 0, pointerEvents: 'none' },
  });
}

// ── plugin entry ────────────────────────────────────────────────────────────
export const inject = ['slots', 'remote', 'workspaces'];

export async function apply(ctx: any) {
  injectStyles();
  setupToggleHotkey();
  const remote = ctx.get('remote');
  await remote.$mount(KANBAN_REMOTE);
  const kanbanApi = ctx.get('remote.kanban');
  // 暴露到 window：作为 useKanbanApi() 的兜底来源，也便于在控制台诊断远程调用。
  (window as any).__kanbanApi = kanbanApi;

  ctx.effect(
    () => installVirtualKanbanWorkspace(ctx, kanbanApi),
    'kanban.virtualWorkspace',
  );

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'kanban',
        order: 50,
        inject: () => ({ onOpen: () => setOverlayOpen(!getOverlayOpen()) }),
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

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'kanban-update',
        order: 60,
        inject: () => ({ kanbanApi }),
      },
      UpdateNotifierSlot as any,
    ),
  );
}
