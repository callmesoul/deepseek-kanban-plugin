<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Plus } from '@lucide/vue';
import { unwrap, useKanbanApi } from '@/lib/bridge';
import { projectFilesFromPaths } from '@/lib/project-files';
import type { CreateTaskOptions, Project } from '@/lib/types';
import {
  AgentComposer,
  formatComposerText,
  uploadComposerAttachments,
  type AgentComposerSubmitPayload,
  type UploadedAttachment,
  type ProjectFile,
} from './agent-composer';
import SchedulePicker from './SchedulePicker.vue';
const props = defineProps<{
  projects: Project[];
  selectedProjectId: string | null;
  submitting: boolean;
}>();

const emit = defineEmits<{
  create: [input: {
    projectId: string;
    title: string;
    description: string;
    attachments: UploadedAttachment[];
    baseBranch: string;
    modelProvider?: string;
    model?: string;
    executeAt?: string | null;
  }];
  'update:selectedProjectId': [id: string];
}>();

const api = useKanbanApi();
const open = ref(false);
const createOptions = ref<CreateTaskOptions | null>(null);
const optionsLoading = ref(false);
const preparing = ref(false);
const branches = ref<string[]>([]);
const branchesLoading = ref(false);
const projectFilesCache = new Map<string, Promise<ProjectFile[]>>();
const descriptionComposerRef = ref<{
  getPayload: () => AgentComposerSubmitPayload;
} | null>(null);

const form = reactive({
  projectId: '',
  baseBranch: '',
  title: '',
  description: '',
  modelProvider: '',
  model: '',
  executeAt: null as string | null,
});

const selectedProject = computed(() =>
  props.projects.find((p) => p.id === form.projectId) ?? null,
);
const selectedModelGroup = computed(() =>
  createOptions.value?.groups.find((group) => group.id === form.modelProvider) ?? null,
);

watch(open, (isOpen) => {
  if (!isOpen) {
    form.description = '';
    return;
  }
  const id = props.selectedProjectId;
  if (id) selectProject(id);
  if (!createOptions.value) {
    void loadCreateOptions();
  } else if (!form.modelProvider) {
    applyDefaultModel();
  }
});

async function loadCreateOptions() {
  if (optionsLoading.value || createOptions.value) return;
  optionsLoading.value = true;
  try {
    createOptions.value = await unwrap(api.listCreateTaskOptions());
    if (!form.modelProvider) applyDefaultModel();
  } catch {
    createOptions.value = { groups: [], defaultModel: null };
  } finally {
    optionsLoading.value = false;
  }
}

function applyDefaultModel() {
  const options = createOptions.value;
  if (!options) return;
  const defaultModel = options.defaultModel;
  const defaultGroup = defaultModel
    ? options.groups.find((group) => group.id === defaultModel.provider)
    : undefined;
  const provider = defaultGroup && defaultModel?.model
    && defaultGroup.models.some((model) => model.id === defaultModel.model)
    ? defaultGroup.id
    : options.groups[0]?.id;
  const group = options.groups.find((item) => item.id === provider);
  form.modelProvider = provider ?? '';
  form.model = group?.models.find((model) => model.id === defaultModel?.model)?.id
    ?? group?.models[0]?.id
    ?? '';
}

function selectProject(id: string) {
  form.projectId = id;
  emit('update:selectedProjectId', id);
  const p = props.projects.find((x) => x.id === id);
  form.baseBranch = p?.branch ?? '';
  if (p?.git) {
    void loadBranches(id);
  } else {
    branches.value = [];
  }
}

async function loadBranches(projectId: string) {
  branchesLoading.value = true;
  try {
    const result = await unwrap(api.listBranches({ projectId }));
    branches.value = result.branches;
    const current = result.current;
    if (current && !form.baseBranch) {
      form.baseBranch = current;
    }
  } catch {
    branches.value = [];
  } finally {
    branchesLoading.value = false;
  }
}

function selectModelProvider(id: string) {
  form.modelProvider = id;
  const group = createOptions.value?.groups.find((item) => item.id === id);
  form.model = group?.models[0]?.id ?? '';
}

function resolveProjectFiles() {
  const projectId = form.projectId;
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

async function submit() {
  if (!form.projectId || !form.title.trim() || preparing.value) return;
  preparing.value = true;
  try {
    const payload = descriptionComposerRef.value?.getPayload();
    const description = payload ? formatComposerText(payload) : form.description.trim();
    const attachments = payload ? await uploadComposerAttachments(payload) : [];
    emit('create', {
      projectId: form.projectId,
      title: form.title.trim(),
      description,
      attachments,
      baseBranch: form.baseBranch.trim(),
      modelProvider: form.modelProvider || undefined,
      model: form.model || undefined,
      executeAt: form.executeAt,
    });
    form.title = '';
    form.description = '';
    form.executeAt = null;
    open.value = false;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '附件上传失败');
  } finally {
    preparing.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <Button>
        <Plus data-icon="inline-start" />
        新建任务
      </Button>
    </DialogTrigger>
    <DialogContent class="sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>新建任务</DialogTitle>
        <DialogDescription>选择项目并填写任务信息，创建后 agent 将自动领取并执行。</DialogDescription>
      </DialogHeader>

      <FieldGroup>
        <Field>
          <FieldLabel for="kb-project">项目</FieldLabel>
          <Select :model-value="form.projectId" @update:model-value="selectProject">
            <SelectTrigger id="kb-project" class="w-full">
              <SelectValue placeholder="选择项目" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem v-for="p in projects" :key="p.id" :value="p.id">
                  {{ p.title }}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription v-if="selectedProject && !selectedProject.git">
            该项目不是 git 仓库，创建后任务会直接进入「暂停中」。
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel for="kb-branch">基础分支（默认当前项目分支）</FieldLabel>
          <Select
            :model-value="form.baseBranch"
            :disabled="!selectedProject?.git || branchesLoading"
            @update:model-value="(value) => (form.baseBranch = value as string)"
          >
            <SelectTrigger id="kb-branch" class="w-full">
              <SelectValue :placeholder="branchesLoading ? '加载分支中…' : '选择基础分支'" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem
                  v-for="b in branches"
                  :key="b"
                  :value="b"
                >
                  {{ b }}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel for="kb-model-provider">执行模型</FieldLabel>
          <div class="grid grid-cols-2 gap-2">
            <Select
              :model-value="form.modelProvider"
              :disabled="optionsLoading || !createOptions"
              @update:model-value="selectModelProvider"
            >
              <SelectTrigger id="kb-model-provider" class="w-full">
                <SelectValue :placeholder="optionsLoading ? '加载中…' : '选择模型服务商'" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem
                    v-for="group in createOptions?.groups ?? []"
                    :key="group.id"
                    :value="group.id"
                  >
                    {{ group.name }}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>

            <Select
              :model-value="form.model"
              :disabled="!selectedModelGroup || optionsLoading"
              @update:model-value="(value) => (form.model = value as string)"
            >
              <SelectTrigger class="w-full">
                <SelectValue placeholder="选择模型" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem
                    v-for="model in selectedModelGroup?.models ?? []"
                    :key="model.id"
                    :value="model.id"
                  >
                    {{ model.name }}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <FieldDescription>默认选择 DSH 当前默认模型。</FieldDescription>
        </Field>

        <Field>
          <FieldLabel>执行时间</FieldLabel>
          <SchedulePicker v-model="form.executeAt" />
          <FieldDescription>默认立即执行；选择未来时间后，agent 会在到点时自动领取执行。空闲时段会自动选择下一个可执行时段。</FieldDescription>
        </Field>

        <Field>
          <FieldLabel for="kb-title">任务标题</FieldLabel>
          <Input id="kb-title" v-model="form.title" placeholder="例如：修复登录页样式" />
        </Field>

        <Field>
          <div class="flex items-baseline justify-between">
            <FieldLabel for="kb-desc">任务描述</FieldLabel>
            <span class="text-[11px] text-muted-foreground">输入 @ 引用项目文件</span>
          </div>
          <AgentComposer
            ref="descriptionComposerRef"
            v-model="form.description"
            input-id="kb-desc"
            aria-label="任务描述"
            :project-root="selectedProject?.path ?? ''"
            :resolve-files="resolveProjectFiles"
            placeholder="描述任务，输入 @ 引用项目文件…"
            :show-directory="false"
            :submit-on-enter="false"
            :show-shortcut-hint="false"
          />
        </Field>
      </FieldGroup>

      <DialogFooter>
        <Button variant="outline" @click="open = false">取消</Button>
        <Button :disabled="submitting || preparing || !form.projectId || !form.title.trim()" @click="submit">
          <Spinner v-if="submitting || preparing" data-icon="inline-start" />
          创建
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
