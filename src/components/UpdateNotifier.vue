<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import { toast } from 'vue-sonner';
import { Toaster } from '@/components/ui/sonner';
import { useDshAppearance } from '@/composables/useDshAppearance';
import type { KanbanApi } from '@/lib/bridge';
import { unwrap } from '@/lib/bridge';
import type { PluginRelease, PluginUpdateInfo, PluginUpdateState } from '@/lib/types';
import { cn } from '@/lib/utils';

const props = defineProps<{ api: KanbanApi }>();
const { isDark } = useDshAppearance();

const TOASTER_ID = 'kanban-updates';
const TOAST_ID = 'kanban-plugin-update';
const POLL_INTERVAL = 2_000;
const POLL_TIMEOUT = 3 * 60 * 1000;
let disposed = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function toastOptions() {
  return { toasterId: TOASTER_ID, id: TOAST_ID } as const;
}

function waitForNextPoll() {
  return new Promise<void>((resolve) => {
    pollTimer = setTimeout(resolve, POLL_INTERVAL);
  });
}

async function acknowledge(targetVersion: string) {
  await unwrap(props.api.acknowledgePluginUpdate({ targetVersion })).catch(() => {});
}

async function finishAppliedUpdate(state: PluginUpdateState) {
  toast.success(`任务看板已更新到 ${state.targetVersion}`, {
    ...toastOptions(),
    description: '正在重新载入页面…',
    duration: 4_000,
  });
  await acknowledge(state.targetVersion);
  if (!disposed) window.setTimeout(() => window.location.reload(), 800);
}

async function showFailure(state: PluginUpdateState, release: PluginRelease | null) {
  toast.error('任务看板更新失败', {
    ...toastOptions(),
    description: state.message || '更新进程未正常完成。',
    duration: Infinity,
    closeButton: true,
    ...(release
      ? {
          action: {
            label: '重试',
            onClick: (event: MouseEvent) => {
              event.preventDefault();
              void startUpdate(release);
            },
          },
        }
      : {}),
  });
  await acknowledge(state.targetVersion);
}

async function pollUpdate(targetVersion: string) {
  const deadline = Date.now() + POLL_TIMEOUT;
  while (!disposed && Date.now() < deadline) {
    await waitForNextPoll();
    if (disposed) return;
    try {
      const info = await unwrap(props.api.getPluginUpdateInfo());
      const state = info.state;
      if (!state || state.targetVersion !== targetVersion) continue;
      if (state.status === 'failed') {
        await showFailure(state, info.update);
        return;
      }
      if (state.status === 'succeeded') {
        if (state.requiresRestart && info.currentVersion !== targetVersion) {
          toast.success(`任务看板 ${targetVersion} 已安装`, {
            ...toastOptions(),
            description: '请重启 DSH 使新版本生效。',
            duration: Infinity,
            closeButton: true,
          });
          return;
        }
        await finishAppliedUpdate(state);
        return;
      }
      toast.loading(state.status === 'restarting' ? '正在重启 DSH…' : `正在安装 ${state.tagName}…`, {
        ...toastOptions(),
        description: state.message,
        duration: Infinity,
        dismissible: false,
      });
    } catch {
      // A short disconnect is expected while systemd restarts dsh-web.
    }
  }

  if (!disposed) {
    toast.error('等待 DSH 重启超时', {
      ...toastOptions(),
      description: '插件可能已经安装，请检查 dsh-web 服务状态后刷新页面。',
      duration: Infinity,
      closeButton: true,
    });
  }
}

async function startUpdate(release: PluginRelease) {
  toast.loading(`正在安装 ${release.tagName}…`, {
    ...toastOptions(),
    description: '下载完成后会自动重启 DSH，请不要关闭页面。',
    duration: Infinity,
    dismissible: false,
  });
  try {
    const state = await unwrap(props.api.startPluginUpdate({ tag: release.tagName }));
    await pollUpdate(state.targetVersion);
  } catch (error: any) {
    toast.error('无法开始更新', {
      ...toastOptions(),
      description: error?.message || String(error),
      duration: Infinity,
      closeButton: true,
    });
  }
}

function showAvailableUpdate(release: PluginRelease) {
  toast.info(`任务看板 ${release.tagName} 已发布`, {
    ...toastOptions(),
    description: release.name,
    duration: Infinity,
    closeButton: true,
    action: {
      label: '立即更新',
      onClick: (event: MouseEvent) => {
        event.preventDefault();
        void startUpdate(release);
      },
    },
    cancel: {
      label: '查看详情',
      onClick: () => window.open(release.url, '_blank', 'noopener,noreferrer'),
    },
  });
}

async function checkForUpdate() {
  try {
    const info: PluginUpdateInfo = await unwrap(props.api.getPluginUpdateInfo());
    if (info.state?.status === 'failed') {
      await showFailure(info.state, info.update);
      return;
    }
    if (info.state && ['installing', 'restarting'].includes(info.state.status)) {
      toast.loading(info.state.status === 'restarting' ? '正在重启 DSH…' : `正在安装 ${info.state.tagName}…`, {
        ...toastOptions(),
        description: info.state.message,
        duration: Infinity,
        dismissible: false,
      });
      await pollUpdate(info.state.targetVersion);
      return;
    }
    if (info.state?.status === 'succeeded') {
      if (info.state.requiresRestart && info.currentVersion !== info.state.targetVersion) {
        toast.success(`任务看板 ${info.state.targetVersion} 已安装`, {
          ...toastOptions(),
          description: '请重启 DSH 使新版本生效。',
          duration: Infinity,
          closeButton: true,
        });
      } else {
        await finishAppliedUpdate(info.state);
      }
      return;
    }
    if (info.enabled && info.update) showAvailableUpdate(info.update);
  } catch {
    // Update checks are best-effort and must never disturb normal board usage.
  }
}

onMounted(() => {
  void checkForUpdate();
});

onBeforeUnmount(() => {
  disposed = true;
  if (pollTimer) clearTimeout(pollTimer);
});
</script>

<template>
  <div :class="cn('dsh-kanban-root pointer-events-auto', { dark: isDark })">
    <Toaster
      :id="TOASTER_ID"
      :theme="isDark ? 'dark' : 'light'"
      position="top-right"
      rich-colors
    />
  </div>
</template>
