import { createApp, type App } from 'vue';
import UpdateNotifier from '@/components/UpdateNotifier.vue';
import type { KanbanApi } from '@/lib/bridge';

export function mountUpdateNotifier(el: HTMLElement, api: KanbanApi): () => void {
  const app: App = createApp(UpdateNotifier, { api });
  app.mount(el);
  return () => app.unmount();
}
