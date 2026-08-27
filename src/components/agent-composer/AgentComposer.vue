<script setup lang="ts">
import { FileIcon, FolderCodeIcon, FolderIcon, LoaderCircleIcon, PaperclipIcon } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { Button } from '@/components/ui/button'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
} from '@/components/ui/input-group'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import AttachmentPreview from './AttachmentPreview.vue'
import { formatAgentInput } from './formatAgentInput'
import type {
  AgentComposerSubmitPayload,
  AgentInputPayload,
  ComposerAttachment,
  ProjectFile,
  ProjectFileResolver,
} from './types'

interface MentionContext {
  start: number
  end: number
  query: string
}

const props = withDefaults(
  defineProps<{
    projectFiles?: ProjectFile[]
    resolveFiles?: ProjectFileResolver
    placeholder?: string
    directoryPlaceholder?: string
    accept?: string
    multiple?: boolean
    disabled?: boolean
    autoFocus?: boolean
    submitOnEnter?: boolean
    clearOnSubmit?: boolean
    showShortcutHint?: boolean
    mentionLimit?: number
    maxAttachments?: number
    showDirectory?: boolean
    inputId?: string
    ariaLabel?: string
  }>(),
  {
    projectFiles: () => [],
    placeholder: '输入消息，使用 @ 引用项目文件…',
    directoryPlaceholder: '/path/to/project',
    accept: undefined,
    multiple: true,
    disabled: false,
    autoFocus: false,
    submitOnEnter: true,
    clearOnSubmit: true,
    showShortcutHint: true,
    mentionLimit: 8,
    maxAttachments: 10,
    showDirectory: true,
    inputId: undefined,
    ariaLabel: '消息',
  },
)

const message = defineModel<string>({ default: '' })
const projectRoot = defineModel<string>('projectRoot', { default: '' })

const emit = defineEmits<{
  submit: [payload: AgentComposerSubmitPayload]
  'agent-submit': [payload: AgentInputPayload]
  'files-selected': [attachments: ComposerAttachment[]]
  'resolver-error': [error: unknown]
}>()

defineSlots<{
  'directory-prefix'(): unknown
  'shortcut-hint'(): unknown
  actions(props: {
    submit: () => void
    canSubmit: boolean
    attachments: ComposerAttachment[]
    mentionedFiles: ProjectFile[]
  }): unknown
  'mention-item'(props: { file: ProjectFile; active: boolean }): unknown
  attachment(props: { attachment: ComposerAttachment; remove: (id: string) => void }): unknown
}>()

const textareaRef = ref<ComponentPublicInstance | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const attachments = ref<ComposerAttachment[]>([])
const mentionedFiles = ref<ProjectFile[]>([])
const isDragging = ref(false)
const isComposing = ref(false)
const mentionContext = ref<MentionContext | null>(null)
const mentionCandidates = ref<ProjectFile[]>([])
const activeMentionIndex = ref(0)
const mentionLoading = ref(false)
const mentionListId = useId()
let searchSequence = 0

const textareaElement = computed(() =>
  textareaRef.value?.$el instanceof HTMLTextAreaElement ? textareaRef.value.$el : null,
)

const mentionOpen = computed(() => mentionContext.value !== null)

const canSubmit = computed(
  () => !props.disabled && (message.value.trim().length > 0 || attachments.value.length > 0),
)

function getMentionContext(value: string, caret: number): MentionContext | null {
  const beforeCaret = value.slice(0, caret)
  const match = beforeCaret.match(/(?:^|\s)@([^\s@]*)$/)
  if (!match || match.index === undefined) return null

  const atOffset = match[0].indexOf('@')
  const start = match.index + atOffset
  return { start, end: caret, query: match[1] ?? '' }
}

function scoreFile(file: ProjectFile, query: string) {
  const path = file.path.toLocaleLowerCase()
  const name = (file.name ?? file.path.split('/').at(-1) ?? file.path).toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  if (!needle) return 0
  if (name.startsWith(needle)) return 0
  if (path.startsWith(needle)) return 1
  if (name.includes(needle)) return 2
  if (path.includes(needle)) return 3
  return Number.POSITIVE_INFINITY
}

function rankFiles(files: ProjectFile[], query: string) {
  return files
    .map((file, index) => ({ file, index, score: scoreFile(file, query) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, props.mentionLimit)
    .map(({ file }) => file)
}

async function searchProjectFiles(query: string) {
  const sequence = ++searchSequence
  mentionLoading.value = Boolean(props.resolveFiles)

  try {
    const files = props.resolveFiles
      ? await props.resolveFiles(query, projectRoot.value)
      : props.projectFiles

    if (sequence !== searchSequence) return
    mentionCandidates.value = rankFiles(files, query)
    activeMentionIndex.value = 0
  } catch (error) {
    if (sequence !== searchSequence) return
    mentionCandidates.value = []
    emit('resolver-error', error)
  } finally {
    if (sequence === searchSequence) mentionLoading.value = false
  }
}

function refreshMention() {
  const textarea = textareaElement.value
  if (!textarea) return

  const context = getMentionContext(message.value, textarea.selectionStart)
  mentionContext.value = context
  if (context) void searchProjectFiles(context.query)
}

function handleKeyup(event: KeyboardEvent) {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    refreshMention()
  }
}

function closeMention() {
  mentionContext.value = null
  mentionCandidates.value = []
  mentionLoading.value = false
  searchSequence += 1
}

async function insertMention(file: ProjectFile) {
  const context = mentionContext.value
  if (!context) return

  const insertedText = `@${file.path} `
  message.value = `${message.value.slice(0, context.start)}${insertedText}${message.value.slice(context.end)}`
  if (!mentionedFiles.value.some((item) => item.path === file.path)) {
    mentionedFiles.value = [...mentionedFiles.value, file]
  }

  closeMention()
  await nextTick()
  const nextCaret = context.start + insertedText.length
  textareaElement.value?.focus()
  textareaElement.value?.setSelectionRange(nextCaret, nextCaret)
}

function handleKeydown(event: KeyboardEvent) {
  if (isComposing.value) return

  if (mentionOpen.value && mentionCandidates.value.length > 0) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      activeMentionIndex.value = (activeMentionIndex.value + 1) % mentionCandidates.value.length
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      activeMentionIndex.value =
        (activeMentionIndex.value - 1 + mentionCandidates.value.length) %
        mentionCandidates.value.length
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      const candidate = mentionCandidates.value[activeMentionIndex.value]
      if (candidate) void insertMention(candidate)
      return
    }
  }

  if (event.key === 'Escape' && mentionContext.value) {
    event.preventDefault()
    closeMention()
    return
  }

  if (event.key === 'Enter' && !event.shiftKey && props.submitOnEnter) {
    event.preventDefault()
    submit()
  }
}

function makeAttachment(file: File): ComposerAttachment {
  const isImage =
    file.type.startsWith('image/') || /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(file.name)
  return {
    id: crypto.randomUUID(),
    file,
    previewUrl: isImage ? URL.createObjectURL(file) : undefined,
  }
}

function addFiles(files: FileList | File[]) {
  const available = Math.max(0, props.maxAttachments - attachments.value.length)
  const nextAttachments = Array.from(files).slice(0, available).map(makeAttachment)
  if (nextAttachments.length === 0) return
  attachments.value = [...attachments.value, ...nextAttachments]
  emit('files-selected', nextAttachments)
}

function removeAttachment(id: string) {
  const attachment = attachments.value.find((item) => item.id === id)
  if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
  attachments.value = attachments.value.filter((item) => item.id !== id)
}

function clearAttachments() {
  attachments.value.forEach((attachment) => {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
  })
  attachments.value = []
}

function handlePaste(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)

  if (files.length > 0) {
    event.preventDefault()
    addFiles(files)
  }
}

function handleDrop(event: DragEvent) {
  event.preventDefault()
  isDragging.value = false
  if (event.dataTransfer?.files.length) addFiles(event.dataTransfer.files)
}

function handleDragLeave(event: DragEvent) {
  const container = event.currentTarget as HTMLElement
  const nextTarget = event.relatedTarget
  if (!(nextTarget instanceof Node) || !container.contains(nextTarget)) {
    isDragging.value = false
  }
}

function getPayload(): AgentComposerSubmitPayload {
  return {
    message: message.value,
    projectRoot: projectRoot.value,
    attachments: [...attachments.value],
    mentionedFiles: [...mentionedFiles.value],
  }
}

function submit() {
  if (!canSubmit.value) return

  const payload = getPayload()

  emit('submit', payload)
  emit('agent-submit', formatAgentInput(payload))

  if (props.clearOnSubmit) {
    message.value = ''
    mentionedFiles.value = []
    clearAttachments()
    closeMention()
  }
}

defineExpose({ getPayload, submit })

watch(message, (value) => {
  mentionedFiles.value = mentionedFiles.value.filter((file) => value.includes(`@${file.path}`))
})

watch([() => props.projectFiles, projectRoot], () => {
  if (mentionContext.value) void searchProjectFiles(mentionContext.value.query)
})

onBeforeUnmount(clearAttachments)
</script>

<template>
  <section
    class="relative w-full"
    aria-label="Agent 消息输入框"
    @dragenter.prevent="isDragging = true"
    @dragover.prevent="isDragging = true"
    @dragleave.prevent="handleDragLeave"
    @drop="handleDrop"
  >
    <div
      class="overflow-hidden rounded-2xl border bg-card text-card-foreground"
    >
      <template v-if="showDirectory">
        <InputGroup class="h-10 rounded-none border-0 bg-muted/35 shadow-none ring-0">
          <InputGroupAddon>
            <slot name="directory-prefix">
              <FolderCodeIcon aria-hidden="true" />
              <InputGroupText>项目目录</InputGroupText>
            </slot>
          </InputGroupAddon>
          <InputGroupInput
            v-model="projectRoot"
            :disabled="disabled"
            :placeholder="directoryPlaceholder"
            aria-label="项目目录"
            autocomplete="off"
          />
        </InputGroup>

        <Separator />
      </template>

      <div class="flex flex-col gap-2 p-3">
        <div v-if="attachments.length" class="no-scrollbar flex gap-2 overflow-x-auto pb-1">
          <template v-for="attachmentItem in attachments" :key="attachmentItem.id">
            <slot name="attachment" :attachment="attachmentItem" :remove="removeAttachment">
              <AttachmentPreview :attachment="attachmentItem" @remove="removeAttachment" />
            </slot>
          </template>
        </div>

        <InputGroup
          class="min-h-24 items-stretch rounded-none border-0 shadow-none ring-0 outline-none has-[[data-slot=input-group-control]:focus-visible]:border-0 has-[[data-slot=input-group-control]:focus-visible]:ring-0"
        >
          <InputGroupTextarea
            ref="textareaRef"
            :id="inputId"
            v-model="message"
            :disabled="disabled"
            :placeholder="placeholder"
            :autofocus="autoFocus"
            rows="3"
            class="max-h-56 min-h-24 border-0 px-1 py-1 text-base leading-6 shadow-none outline-none ring-0 focus-visible:border-0 focus-visible:outline-none focus-visible:ring-0 md:text-sm"
            :aria-label="ariaLabel"
            aria-autocomplete="list"
            :aria-expanded="mentionOpen"
            :aria-controls="mentionListId"
            @input="refreshMention"
            @click="refreshMention"
            @keyup="handleKeyup"
            @keydown="handleKeydown"
            @paste="handlePaste"
            @compositionstart="isComposing = true"
            @compositionend="isComposing = false"
          />
        </InputGroup>

        <footer class="flex min-h-8 items-center justify-between gap-2">
          <div class="flex min-w-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              :disabled="disabled || attachments.length >= maxAttachments"
              aria-label="添加附件"
              @click="fileInputRef?.click()"
            >
              <PaperclipIcon />
            </Button>

            <slot v-if="showShortcutHint && submitOnEnter" name="shortcut-hint">
              <span
                class="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground"
                aria-label="Shift 加 Enter 换行"
              >
                <KbdGroup>
                  <Kbd>SHIFT</Kbd>
                  <span aria-hidden="true">+</span>
                  <Kbd>ENTER</Kbd>
                </KbdGroup>
                <span>换行</span>
              </span>
            </slot>
          </div>

          <div class="flex items-center gap-1">
            <slot
              name="actions"
              :submit="submit"
              :can-submit="canSubmit"
              :attachments="attachments"
              :mentioned-files="mentionedFiles"
            />
          </div>
        </footer>
      </div>
    </div>

    <div
      v-if="mentionOpen"
      :id="mentionListId"
      class="absolute bottom-full left-0 right-0 mb-2"
      role="presentation"
    >
      <Command class="max-h-72 border">
        <CommandList>
          <CommandGroup heading="项目文件">
            <CommandItem v-if="mentionLoading" disabled value="loading">
              <LoaderCircleIcon class="animate-spin" />
              正在匹配文件…
            </CommandItem>

            <CommandItem
              v-for="(file, index) in mentionCandidates"
              :key="file.path"
              :value="file.path"
              :aria-selected="index === activeMentionIndex"
              :class="cn(index === activeMentionIndex && 'bg-muted text-foreground')"
              @pointerenter="activeMentionIndex = index"
              @pointerdown.prevent
              @select="insertMention(file)"
            >
              <FolderIcon v-if="file.kind === 'directory'" />
              <FileIcon v-else />
              <div class="min-w-0 flex-1">
                <slot name="mention-item" :file="file" :active="index === activeMentionIndex">
                  <p class="truncate text-sm">
                    {{ file.name ?? file.path.split(/[\\/]/).at(-1) }}
                  </p>
                  <p class="truncate text-xs text-muted-foreground">{{ file.path }}</p>
                </slot>
              </div>
            </CommandItem>

            <CommandItem
              v-if="!mentionLoading && mentionCandidates.length === 0"
              disabled
              value="empty"
            >
              没有匹配的文件
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </div>

    <div
      v-if="isDragging"
      class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary bg-background/90 text-primary backdrop-blur-sm"
    >
      <PaperclipIcon class="size-8" aria-hidden="true" />
      <p class="text-sm font-medium">松开即可添加附件</p>
    </div>

    <input
      ref="fileInputRef"
      class="sr-only"
      type="file"
      :accept="accept"
      :multiple="multiple"
      tabindex="-1"
      @change="
        ($event) => {
          const input = $event.target as HTMLInputElement
          if (input.files) addFiles(input.files)
          input.value = ''
        }
      "
    />
  </section>
</template>
