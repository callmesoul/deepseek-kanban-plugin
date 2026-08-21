<script setup lang="ts">
import { computed } from 'vue';
import KanbanStatusBadge from './KanbanStatusBadge.vue';
import { STATUSES, STATUS_LABEL, type Task, type TaskStatus } from '@/lib/types';

/**
 * Roadmap 路线图视图（参考 GitHub Projects 的 Roadmap 甘特图）：
 * - 左侧固定任务列表，右侧横向滚动时间轴（周/月刻度自适应）
 * - 按状态分组泳道，每个任务一条横杆
 * - 任务起点 = executeAt ?? createdAt，终点 = done ? updatedAt : 今天
 */

const props = defineProps<{ tasks: Task[] }>();
const emit = defineEmits<{ open: [task: Task] }>();

const DAY_MS = 86_400_000;
const LEFT_W = 300;
const ROW_H = 44;
const GROUP_H = 30;
const MONTH_W = 150;
const WEEK_W = 52;
const MIN_BAR_W = 16;

interface Span {
  task: Task;
  start: Date;
  end: Date;
}

function taskStart(t: Task): Date {
  return t.executeAt ? new Date(t.executeAt) : new Date(t.createdAt);
}
function taskEnd(t: Task): Date {
  return t.status === 'done' ? new Date(t.updatedAt) : new Date();
}

const spans = computed<Span[]>(() =>
  props.tasks.map((task) => ({ task, start: taskStart(task), end: taskEnd(task) })),
);

const bounds = computed(() => {
  const now = Date.now();
  let min = now;
  let max = now;
  for (const s of spans.value) {
    min = Math.min(min, s.start.getTime());
    max = Math.max(max, s.end.getTime());
  }
  if (max - min < 30 * DAY_MS) max = min + 30 * DAY_MS;
  return { min: new Date(min), max: new Date(max) };
});

const mode = computed(() =>
  bounds.value.max.getTime() - bounds.value.min.getTime() > 100 * DAY_MS ? 'month' : 'week',
);

interface Tick {
  label: string;
  date: Date;
}

const ticks = computed<Tick[]>(() => {
  const { min, max } = bounds.value;
  const res: Tick[] = [];
  if (mode.value === 'month') {
    const d = new Date(min.getFullYear(), min.getMonth(), 1);
    const end = new Date(max.getFullYear(), max.getMonth() + 1, 1);
    while (d < end) {
      res.push({
        label: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        date: new Date(d),
      });
      d.setMonth(d.getMonth() + 1);
    }
    return res;
  }
  const d = new Date(min);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // 对齐到本周周一
  d.setHours(0, 0, 0, 0);
  while (d <= max) {
    res.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, date: new Date(d) });
    d.setDate(d.getDate() + 7);
  }
  return res;
});

const unitW = computed(() => (mode.value === 'month' ? MONTH_W : WEEK_W));
const timelineW = computed(() => Math.max(ticks.value.length, 1) * unitW.value);

function xOf(date: Date): number {
  const first = ticks.value[0];
  if (!first) return 0;
  if (mode.value === 'month') {
    const months =
      (date.getFullYear() - first.date.getFullYear()) * 12 + (date.getMonth() - first.date.getMonth());
    const dim = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    const frac = (date.getDate() - 1) / dim;
    return (months + frac) * MONTH_W;
  }
  return ((date.getTime() - first.date.getTime()) / (7 * DAY_MS)) * WEEK_W;
}

function widthOf(s: Span): number {
  return Math.max(xOf(s.end) - xOf(s.start), MIN_BAR_W);
}

const todayX = computed(() => xOf(new Date()));

const groups = computed(() =>
  STATUSES.map((s) => ({
    ...s,
    spans: spans.value.filter((x) => x.task.status === s.id),
  })),
);

const STATUS_BG: Record<TaskStatus, string> = {
  todo: 'var(--color-status-todo)',
  running: 'var(--color-status-running)',
  paused: 'var(--color-status-paused)',
  review: 'var(--color-status-review)',
  approved: 'var(--color-status-approved)',
  done: 'var(--color-status-done)',
};

function fmt(d: Date): string {
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
function rangeLabel(s: Span): string {
  return `${fmt(s.start)} - ${fmt(s.end)}`;
}

const totalTasks = computed(() => props.tasks.length);
</script>

<template>
  <div
    v-if="totalTasks === 0"
    class="flex h-full items-center justify-center rounded-lg border bg-background"
  >
    <div class="text-center text-muted-foreground">
      <p class="text-sm">暂无任务</p>
      <p class="mt-1 text-xs">在「看板」页签新建任务后，这里会显示时间路线</p>
    </div>
  </div>

  <div v-else class="flex h-full min-h-0 flex-col gap-2">
    <div class="flex items-center gap-3 px-1 text-xs text-muted-foreground">
      <span class="inline-flex items-center gap-1.5">
        <span class="inline-block size-3 rounded-sm border border-border bg-muted"></span>
        任务时间范围（按{{ mode === 'month' ? '月' : '周' }}刻度）
      </span>
      <span class="ml-auto inline-flex items-center gap-1.5">
        <span class="inline-block h-2.5 w-0.5 rounded bg-primary"></span>
        今天
      </span>
    </div>

    <div class="min-h-0 flex-1 overflow-auto rounded-lg border bg-background">
      <div class="flex w-max min-w-full">
        <!-- 左侧固定任务列表 -->
        <div class="sticky left-0 z-10 shrink-0 border-r bg-background" :style="{ width: LEFT_W + 'px' }">
          <div class="sticky top-0 z-[6] h-8 border-b bg-muted/40" />
          <template v-for="g in groups" :key="g.id">
            <div
              class="flex h-7 items-center gap-1.5 border-b bg-muted/40 px-3 text-xs font-semibold text-muted-foreground"
            >
              {{ g.label }}
              <span class="text-muted-foreground/60">{{ g.spans.length }}</span>
            </div>
            <div
              v-for="s in g.spans"
              :key="s.task.id"
              class="flex h-11 cursor-pointer items-center gap-2 border-b border-border/50 px-3 hover:bg-muted/40"
              @click="emit('open', s.task)"
            >
              <KanbanStatusBadge :s="s.task.status" class="shrink-0">
                {{ STATUS_LABEL[s.task.status] }}
              </KanbanStatusBadge>
              <span class="truncate text-sm font-medium">{{ s.task.title }}</span>
              <span class="ml-auto shrink-0 text-[11px] text-muted-foreground">{{ rangeLabel(s) }}</span>
            </div>
          </template>
        </div>

        <!-- 右侧时间轴 -->
        <div class="relative shrink-0" :style="{ width: timelineW + 'px' }">
          <!-- 刻度行（sticky 顶部） -->
          <div class="sticky top-0 z-[5] h-8 border-b bg-background">
            <div
              v-for="(t, i) in ticks"
              :key="'tick-' + i"
              class="absolute inset-y-0 border-l border-border/60"
              :style="{ left: i * unitW + 'px', width: unitW + 'px' }"
            >
              <span class="absolute left-1.5 top-1.5 whitespace-nowrap text-[11px] text-muted-foreground">
                {{ t.label }}
              </span>
            </div>
          </div>

          <!-- 泳道主体 -->
          <template v-for="g in groups" :key="'body-' + g.id">
            <div class="relative border-b bg-muted/20" :style="{ height: GROUP_H + 'px' }">
              <div
                v-for="(t, i) in ticks"
                :key="'gh-' + i"
                class="absolute inset-y-0 border-l border-border/40"
                :style="{ left: i * unitW + 'px' }"
              />
            </div>
            <div
              v-for="s in g.spans"
              :key="'row-' + s.task.id"
              class="relative border-b border-border/50"
              :style="{ height: ROW_H + 'px' }"
            >
              <div
                v-for="(t, i) in ticks"
                :key="'rv-' + i"
                class="absolute inset-y-0 border-l border-border/30"
                :style="{ left: i * unitW + 'px' }"
              />
              <div class="absolute inset-y-0 z-[4] w-px bg-primary/70" :style="{ left: todayX + 'px' }" />
              <div
                class="absolute z-[3] flex cursor-pointer items-center overflow-hidden rounded-md px-1.5 text-[11px] font-medium text-white/90 transition-all hover:brightness-110 hover:shadow-md"
                :style="{
                  left: xOf(s.start) + 'px',
                  width: widthOf(s) + 'px',
                  top: (ROW_H - 22) / 2 + 'px',
                  height: '22px',
                  background: STATUS_BG[s.task.status],
                  opacity: s.task.status === 'done' ? 1 : 0.78,
                }"
                :title="`${s.task.title}（${STATUS_LABEL[s.task.status]}）${rangeLabel(s)}`"
                @click="emit('open', s.task)"
              >
                <span v-if="widthOf(s) >= 64" class="truncate">{{ s.task.title }}</span>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
