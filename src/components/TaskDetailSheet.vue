<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ComponentPublicInstance } from 'vue';
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
import KanbanStatusBadge from './KanbanStatusBadge.vue';
import { Textarea } from '@/components/ui/textarea';
import { Play, Check, Trash2, Send } from '@lucide/vue';
import { STATUS_LABEL, type Task } from '@/lib/types';
import { unwrap, useKanbanApi } from '@/lib/bridge';
import { usePathAutocomplete } from '@/composables/usePathAutocomplete';
import PathSuggestionList from './PathSuggestionList.vue';

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

// 评论输入框的 "/" 路径补全
const commentTextareaRef = ref<HTMLElement | ComponentPublicInstance | null>(null);
const commentPathSuggest = usePathAutocomplete({
  element: commentTextareaRef,
  model: commentDraft,
  cacheKey: () => task.value?.projectId ?? null,
  resolvePaths: async () => {
    const id = task.value?.projectId;
    if (!id) return [];
    const result = await unwrap(api.listProjectPaths({ projectId: id }));
    return result.paths;
  },
});
const taskBranch = computed(() => task.value?.taskBranch || '—');
const baseBranch = computed(() => task.value?.baseBranch || '—');
const canResume = computed(() => task.value?.status === 'paused' || task.value?.status === 'todo');
const canApprove = computed(() => task.value?.status === 'review' || task.value?.status === 'approved');
const canComment = computed(() => task.value?.status === 'review');
const comments = computed(() => task.value?.comments ?? []);
const changeLogs = computed(() => [...(task.value?.changeLogs ?? [])].reverse());

function changeSourceLabel(source: 'agent' | 'git' | 'system') {
  if (source === 'agent') return 'Agent 说明';
  if (source === 'git') return 'Git 变更';
  return '系统记录';
}

watch(
  () => props.task?.id,
  () => {
    commentDraft.value = '';
    commentPathSuggest.close();
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
    <SheetContent side="right" class="flex h-full w-full flex-col p-0 sm:max-w-lg">
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
              <div class="text-xs font-medium text-muted-foreground">任务描述</div>
              <p class="text-sm whitespace-pre-wrap leading-6">
                {{ task.description || '（无描述）' }}
              </p>
            </section>

            <Separator />

            <section v-if="task.message" class="flex flex-col gap-2">
              <div class="text-xs font-medium text-muted-foreground">状态说明</div>
              <div class="rounded-lg border bg-muted/40 p-3 text-sm leading-6 whitespace-pre-wrap">
                {{ task.message }}
              </div>
            </section>

            <Separator v-if="task.message" />

            <section class="flex flex-col gap-2">
              <div class="text-xs font-medium text-muted-foreground">改动记录</div>
              <div v-if="changeLogs.length" class="flex flex-col gap-2">
                <div
                  v-for="log in changeLogs"
                  :key="log.id"
                  class="rounded-lg border bg-muted/40 p-3 text-sm leading-6"
                >
                  <div class="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{{ new Date(log.createdAt).toLocaleString() }}</span>
                    <Badge variant="secondary">{{ changeSourceLabel(log.source) }}</Badge>
                    <span v-if="log.commit" class="font-mono">{{ log.commit }}</span>
                  </div>
                  <div class="whitespace-pre-wrap">{{ log.summary }}</div>
                </div>
              </div>
              <div v-else class="text-sm text-muted-foreground">暂无改动记录</div>
            </section>

            <Separator />

            <section class="flex flex-col gap-2">
              <div class="text-xs font-medium text-muted-foreground">评论记录</div>
              <div v-if="comments.length" class="flex flex-col gap-2">
                <div
                  v-for="comment in comments"
                  :key="comment.id"
                  class="rounded-lg border bg-muted/40 p-3 text-sm leading-6"
                >
                  <div class="mb-1 text-xs text-muted-foreground">
                    {{ new Date(comment.createdAt).toLocaleString() }}
                  </div>
                  <div class="whitespace-pre-wrap">{{ comment.content }}</div>
                </div>
              </div>
              <div v-else class="text-sm text-muted-foreground">暂无评论记录</div>
            </section>

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
            <div class="relative">
              <Textarea
                ref="commentTextareaRef"
                v-model="commentDraft"
                class="min-h-24"
                placeholder="给 agent 补充要求或反馈，发送后继续执行…"
                :disabled="busy"
              />
              <PathSuggestionList
                :open="commentPathSuggest.open"
                :loading="commentPathSuggest.loading"
                :has-error="commentPathSuggest.hasError"
                :items="commentPathSuggest.items"
                :active-index="commentPathSuggest.activeIndex"
                :position="commentPathSuggest.position"
                :total="commentPathSuggest.total"
                @select="commentPathSuggest.select"
                @hover="commentPathSuggest.setActive"
              />
            </div>
            <p class="text-xs text-muted-foreground">
              输入 <code class="rounded bg-muted px-1 font-mono text-[11px]">/</code> 可快速引用项目文件路径
            </p>
            <Button
              :disabled="busy || !commentDraft.trim()"
              @click="emit('comment', task.id, commentDraft.trim())"
            >
              <Spinner v-if="busy" data-icon="inline-start" />
              <Send v-else data-icon="inline-start" />
              评论并继续
            </Button>
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
