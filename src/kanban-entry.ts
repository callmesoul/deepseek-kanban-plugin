import { createApp, type App } from 'vue';
import AppRoot from './App.vue';
import { KANBAN_API, type KanbanApi } from './lib/bridge';

/**
 * Mount the kanban Vue app into a host-owned container element.
 * Returns a disposer that unmounts the app (React cleanup).
 */
export function mountKanban(el: HTMLElement, api: KanbanApi): () => void {
  const app: App = createApp(AppRoot);
  app.provide(KANBAN_API, api);
  app.mount(el);
  return () => {
    app.unmount();
  };
}
