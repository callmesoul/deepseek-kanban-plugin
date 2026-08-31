<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { projectFilesFromPaths } from '@/lib/project-files';
import KanbanStatusBadge from './KanbanStatusBadge.vue';
import MarkdownPreview from './MarkdownPreview.vue';
import {
  AgentComposer,
  formatComposerText,
  type AgentComposerSubmitPayload,
  type ProjectFile,
} from './agent-composer';
import { Play, Check, Trash2, Send } from '@lucide/vue';
import {
  STATUS_LABEL,
  type Task,
  type TaskChangeLog,
} from '@/lib/types';
import { unwrap, useKanbanApi } from '@/lib/bridge';

const props = defineProps<{ task: Task | null; busy: boolean }>();
const emit = defineEmits<{
  approve: [taskId: string];
  resume: [taskId: string];
  comment: [taskId: string, comment: string];
  remove: [taskId: string];
  close: [];
}>();

const api = useKanbanApi();
const task = computed(() => props.task);
const commentDraft = ref('');
const projectFilesCache = new Map<string, Promise<ProjectFile[]>>();

const taskBranch = computed(() => task.value?.taskBranch || '—');
const baseBranch = computed(() => task.value?.baseBranch || '—');
const canResume = computed(() => task.value?.status === 'paused' || task.value?.status === 'todo');
const canApprove = computed(() => task.value?.status === 'review' || task.value?.status === 'approved');
const canComment = computed(() => task.value?.status === 'review');

type TaskRecord =
  | {
      id: string;
      kind: 'description' | 'comment';
      content: string;
      createdAt: string;
    }
  | {
      id: string;
      kind: 'result';
      content: string;
      createdAt: string;
      source: TaskChangeLog['source'];
      commit: string | null;
    };

const taskRecords = computed<TaskRecord[]>(() => {
  if (!task.value) return [];

  const history: TaskRecord[] = [
    ...task.value.changeLogs.map((log) => ({
      id: `result-${log.id}`,
      kind: 'result' as const,
      content: log.summary,
      createdAt: log.createdAt,
      source: log.source,
      commit: log.commit,
    })),
    ...task.value.comments.map((comment) => ({
      id: `comment-${comment.id}`,
      kind: 'comment' as const,
      content: comment.content,
      createdAt: comment.createdAt,
    })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return [
    {
      id: `description-${task.value.id}`,
      kind: 'description',
      content: task.value.description,
      createdAt: task.value.createdAt,
    },
    ...history,
  ];
});

function changeSourceLabel(source: 'agent' | 'git' | 'system') {
  if (source === 'agent') return 'Agent 说明';
  if (source === 'git') return 'Git 变更';
  return '系统记录';
}

function resolveProjectFiles() {
  const projectId = task.value?.projectId;
  if (!projectId) return Promise.resolve([]);

  const cached = projectFilesCache.get(projectId);
  if (cached) return cached;

  const pending = unwrap(api.listProjectPaths({ projectId }))
    .then(({ paths }) => projectFilesFromPaths(paths))
    .catch((error) => {
      projectFilesCache.delete(projectId);
      throw error;
    });
  projectFilesCache.set(projectId, pending);
  return pending;
}

function submitComment(payload: AgentComposerSubmitPayload) {
  const comment = formatComposerText(payload);
  if (!task.value || !comment) return;
  emit('comment', task.value.id, comment);
}

watch(
  () => props.task?.id,
  () => {
    commentDraft.value = '';
  },
);

const metaRows = computed(() => {
  if (!task.value) return [];
  return [
    { label: '创建时间', value: new Date(task.value.createdAt).toLocaleString() },
    ...(task.value.modelProvider || task.value.model
      ? [{
          label: '执行模型',
          value: [task.value.modelProvider, task.value.model].filter(Boolean).join(' / '),
        }]
      : []),
    {
      label: '执行时间',
      value: task.value.executeAt
        ? new Date(task.value.executeAt).toLocaleString()
        : '立即执行',
    },
    ...(task.value.worktreePath
      ? [{ label: 'Worktree', value: task.value.worktreePath }]
      : []),
    ...(task.value.agentSessionId
      ? [{ label: 'Agent 会话', value: task.value.agentSessionId }]
      : []),
  ];
});
</script>

<template>
  <Sheet :open="task !== null" @update:open="(v) => !v && emit('close')">
    <SheetContent side="right" class="flex h-full w-full flex-col p-0 sm:max-w-3xl">
      <template v-if="task">
        <SheetHeader class="border-b px-5 py-4 pr-12">
          <div class="flex items-start gap-3">
            <div class="min-w-0 flex-1">
              <SheetTitle class="text-base leading-snug">{{ task.title }}</SheetTitle>
              <SheetDescription class="mt-1 flex items-center gap-2">
                <Badge variant="secondary">{{ baseBranch }}</Badge>
                <span class="text-muted-foreground">→</span>
                <Badge variant="secondary">{{ taskBranch }}</Badge>
              </SheetDescription>
            </div>
            <KanbanStatusBadge :s="task.status">
              {{ STATUS_LABEL[task.status] }}
            </KanbanStatusBadge>
          </div>
        </SheetHeader>

        <ScrollArea class="min-h-0 flex-1">
          <div class="flex flex-col gap-5 px-5 py-4">
            <section class="flex flex-col gap-2">
              <div class="text-xs font-medium text-muted-foreground">任务记录</div>
              <div class="flex flex-col gap-2">
                <div
                  v-for="record in taskRecords"
                  :key="record.id"
                  class="rounded-lg border bg-muted/40 p-3"
                >
                  <div class="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge :variant="record.kind === 'result' ? 'default' : 'secondary'">
                      {{ record.kind === 'description' ? '任务描述' : record.kind === 'result' ? '结果' : '评论' }}
                    </Badge>
                    <span>{{ new Date(record.createdAt).toLocaleString() }}</span>
                    <Badge v-if="record.kind === 'result'" variant="secondary">
                      {{ changeSourceLabel(record.source) }}
                    </Badge>
                    <span v-if="record.kind === 'result' && record.commit" class="font-mono">
                      {{ record.commit }}
                    </span>
                  </div>
                  <MarkdownPreview
                    :content="record.content"
                    :placeholder="record.kind === 'description' ? '（无描述）' : '（无内容）'"
                  />
                </div>
              </div>
            </section>

            <template v-if="task.message">
              <Separator />
              <section class="flex flex-col gap-2">
                <div class="text-xs font-medium text-muted-foreground">当前状态</div>
                <div class="rounded-lg border bg-muted/40 p-3">
                  <MarkdownPreview :content="task.message" />
                </div>
              </section>
            </template>

            <Separator />

            <section class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div v-for="row in metaRows" :key="row.label" class="min-w-0">
                <div class="text-xs text-muted-foreground">{{ row.label }}</div>
                <div class="mt-1 truncate text-sm" :title="row.value">{{ row.value }}</div>
              </div>
            </section>
          </div>
        </ScrollArea>

        <SheetFooter class="border-t px-5 py-4">
          <div v-if="canComment" class="flex flex-col gap-2">
            <div class="flex items-baseline justify-between">
              <span class="text-xs font-medium text-foreground">评论</span>
              <span class="text-[11px] text-muted-foreground">输入 @ 引用项目文件</span>
            </div>
            <AgentComposer
              v-model="commentDraft"
              :project-root="task.worktreePath"
              :resolve-files="resolveProjectFiles"
              placeholder="输入评论，使用 @ 引用项目文件…"
              :disabled="busy"
              :show-directory="false"
              :clear-on-submit="false"
              @submit="submitComment"
            >
              <template #actions="{ submit, canSubmit }">
                <Button size="sm" :disabled="busy || !canSubmit" @click="submit">
                  <Spinner v-if="busy" data-icon="inline-start" />
                  <Send v-else data-icon="inline-start" />
                  评论并继续
                </Button>
              </template>
            </AgentComposer>
          </div>
          <Button
            v-if="canResume"
            variant="outline"
            :disabled="busy"
            @click="emit('resume', task.id)"
          >
            <Spinner v-if="busy" data-icon="inline-start" />
            <Play v-else data-icon="inline-start" />
            继续执行
          </Button>
          <Button
            v-if="canApprove"
            :disabled="busy"
            @click="emit('approve', task.id)"
          >
            <Spinner v-if="busy" data-icon="inline-start" />
            <Check v-else data-icon="inline-start" />
            审核通过并合回
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="删除任务"
            :disabled="busy"
            @click="emit('remove', task.id)"
          >
            <Trash2 data-icon="inline-start" />
          </Button>
        </SheetFooter>
      </template>
    </SheetContent>
  </Sheet>
</template>
