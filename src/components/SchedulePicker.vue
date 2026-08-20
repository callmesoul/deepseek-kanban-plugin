<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DateValue } from '@internationalized/date';
import {
  CalendarDate,
  getLocalTimeZone,
  today,
} from '@internationalized/date';
import { CalendarIcon } from '@lucide/vue';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const props = defineProps<{
  modelValue: string | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string | null];
}>();

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function tomorrowNine() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date;
}

const now = () => new Date();

const IDLE_WINDOWS = [
  { start: 0, end: 8 * 60 + 59 },
  { start: 12 * 60 + 1, end: 13 * 60 + 59 },
  { start: 18 * 60 + 1, end: 23 * 60 + 59 },
];

function minutesOfDay(date: Date) {
  return date.getHours() * 60 + date.getMinutes();
}

function atDayMinutes(day: Date, minutes: number) {
  const date = new Date(day);
  date.setHours(0, 0, 0, 0);
  date.setMinutes(minutes, 0, 0);
  return date;
}

function isIdleDateTime(date: Date) {
  const minutes = minutesOfDay(date);
  return IDLE_WINDOWS.some((window) => minutes >= window.start && minutes <= window.end);
}

function nextIdleTime(from = now()) {
  const current = new Date(from);
  if (isIdleDateTime(current)) return current;

  const day = new Date(current);
  day.setHours(0, 0, 0, 0);

  for (const window of IDLE_WINDOWS) {
    const candidate = atDayMinutes(day, window.start);
    if (candidate.getTime() > current.getTime()) return candidate;
  }

  const nextDay = new Date(day);
  nextDay.setDate(nextDay.getDate() + 1);
  return atDayMinutes(nextDay, IDLE_WINDOWS[0].start);
}

const presets = [
  { key: 'now', label: '立即执行' },
  { key: '30m', label: '30 分钟后' },
  { key: '1h', label: '1 小时后' },
  { key: 'tomorrow9', label: '明天 09:00' },
  { key: 'idle', label: '空闲时段（00:00-08:59 / 12:01-13:59 / 18:01-23:59）' },
  { key: 'custom', label: '自定义时间…' },
];

const selectedKey = ref('now');
const customDate = ref<DateValue>();
const customTime = ref('');
const minDate = computed(() => today(getLocalTimeZone()));

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

const hours = Array.from({ length: 24 }, (_, index) => String(index));
const minutes = Array.from({ length: 60 }, (_, index) => String(index));

function valueForPreset(key: string) {
  if (key === 'now') return null;
  if (key === '30m') return addMinutes(now(), 30).toISOString();
  if (key === '1h') return addMinutes(now(), 60).toISOString();
  if (key === 'tomorrow9') return tomorrowNine().toISOString();
  if (key === 'idle') return nextIdleTime().toISOString();
  return props.modelValue ?? addMinutes(now(), 120).toISOString();
}

function keyForValue(value: string | null) {
  if (!value) return 'now';
  const target = new Date(value).getTime();
  if (Number.isNaN(target)) return 'custom';
  if (Math.abs(target - addMinutes(now(), 30).getTime()) < 1000) return '30m';
  if (Math.abs(target - addMinutes(now(), 60).getTime()) < 1000) return '1h';
  if (Math.abs(target - tomorrowNine().getTime()) < 1000) return 'tomorrow9';
  if (isIdleDateTime(new Date(value))) return 'idle';
  return 'custom';
}

function toCalendarDate(date: Date) {
  return new CalendarDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function syncCustomFromModel(value: string | null) {
  if (!value) return;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return;
  customDate.value = toCalendarDate(date);
  customTime.value = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function customDateText(date: DateValue) {
  return dateFormatter.format(date.toDate(getLocalTimeZone()));
}

const currentHour = computed(() => Number(customTime.value.split(':')[0] ?? '0'));
const currentMinute = computed(() => Number(customTime.value.split(':')[1] ?? '0'));

const selectedDateIsToday = computed(() => {
  if (!customDate.value) return false;
  const selected = customDate.value.toDate(getLocalTimeZone());
  const current = now();
  return (
    selected.getFullYear() === current.getFullYear()
    && selected.getMonth() === current.getMonth()
    && selected.getDate() === current.getDate()
  );
});

function isTimeDisabled(hour: number, minute: number) {
  if (!selectedDateIsToday.value) return false;
  const current = now();
  const candidate = new Date(current);
  candidate.setHours(hour, minute, 0, 0);
  return candidate.getTime() <= current.getTime();
}

function emitCustomDateTime() {
  if (!customDate.value || !customTime.value) return;
  const date = customDate.value.toDate(getLocalTimeZone());
  const [hour, minute] = customTime.value.split(':').map(Number);
  date.setHours(hour, minute, 0, 0);
  emit('update:modelValue', date.toISOString());
}

function selectPreset(key: string) {
  selectedKey.value = key;
  emit('update:modelValue', valueForPreset(key));
}

function selectCustomDate(value: DateValue | undefined, close?: () => void) {
  if (!value) return;
  customDate.value = value;
  if (!customTime.value) {
    const fallback = addMinutes(now(), 120);
    customTime.value = `${pad(fallback.getHours())}:${pad(fallback.getMinutes())}`;
  }
  emitCustomDateTime();
  close?.();
}

function selectCustomHour(value: string) {
  customTime.value = `${pad(Number(value))}:${pad(currentMinute.value)}`;
  emitCustomDateTime();
}

function selectCustomMinute(value: string) {
  customTime.value = `${pad(currentHour.value)}:${pad(Number(value))}`;
  emitCustomDateTime();
}

watch(
  () => props.modelValue,
  (value) => {
    if (selectedKey.value === 'custom') {
      if (value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return;
        customDate.value = toCalendarDate(date);
        customTime.value = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
      }
      return;
    }

    selectedKey.value = keyForValue(value);
    if (value && selectedKey.value === 'custom') syncCustomFromModel(value);
  },
  { immediate: true },
);
</script>

<template>
  <div class="flex flex-col gap-2">
    <Select :model-value="selectedKey" @update:model-value="selectPreset">
      <SelectTrigger class="w-full">
        <SelectValue placeholder="选择执行时间" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem
            v-for="preset in presets"
            :key="preset.key"
            :value="preset.key"
          >
            {{ preset.label }}
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>

    <div v-if="selectedKey === 'custom'" class="flex flex-col gap-2">
      <Popover v-slot="{ close }">
        <PopoverTrigger as-child>
          <Button
            variant="outline"
            :class="cn(
              'w-full justify-start text-left font-normal',
              !customDate && 'text-muted-foreground',
            )"
          >
            <CalendarIcon data-icon="inline-start" />
            {{ customDate ? customDateText(customDate) : '选择日期' }}
          </Button>
        </PopoverTrigger>
        <PopoverContent class="w-auto p-0" align="start">
          <Calendar
            :model-value="customDate"
            :min-value="minDate"
            :default-placeholder="customDate ?? minDate"
            :prevent-deselect="true"
            locale="zh-CN"
            layout="month-and-year"
            initial-focus
            @update:model-value="(value) => selectCustomDate(value, close)"
          />
        </PopoverContent>
      </Popover>

      <div class="grid grid-cols-2 gap-2">
        <Select
          :model-value="String(currentHour)"
          :disabled="!customDate"
          @update:model-value="selectCustomHour"
        >
          <SelectTrigger class="w-full">
            <SelectValue placeholder="小时" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem
                v-for="hour in hours"
                :key="hour"
                :value="hour"
                :disabled="isTimeDisabled(Number(hour), currentMinute)"
              >
                {{ pad(Number(hour)) }} 时
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>

        <Select
          :model-value="String(currentMinute)"
          :disabled="!customDate"
          @update:model-value="selectCustomMinute"
        >
          <SelectTrigger class="w-full">
            <SelectValue placeholder="分钟" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem
                v-for="minute in minutes"
                :key="minute"
                :value="minute"
                :disabled="isTimeDisabled(currentHour, Number(minute))"
              >
                {{ pad(Number(minute)) }} 分
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    </div>
  </div>
</template>
