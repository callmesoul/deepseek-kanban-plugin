# @deepseek-kanban/plugin

DeepSeek Harness（DSH）任务看板插件 —— 在 DSH Web 左侧边栏提供「任务看板」，把**项目、git 分支、AI agent** 串成一条自动化开发流水线：创建任务 → agent 自动领取执行 → 自动提交 → 人工审核 → 自动合并回基础分支。

## 安装

从 GitHub 直接安装（推荐）：

```bash
dsh plugin --profile web add "github:callmesoul/deepseek-kanban-plugin"
```

如需指定版本 / 分支（Tag 或 commit 后跟 `#`）：

```bash
dsh plugin --profile web add "github:callmesoul/deepseek-kanban-plugin#main"
```

安装完成后**重启 / 重载 DSH 应用**，侧边栏底部出现「任务看板」入口即安装成功。

> 强制刷新安装：`dsh plugin --profile web remove @deepseek-kanban/plugin && dsh plugin --profile web add "github:callmesoul/deepseek-kanban-plugin"`

## 功能特性

- **看板入口**：DSH Web 侧边栏底部「任务看板」按钮，点击打开全屏看板面板（2s 轮询实时刷新）。
- **任务状态机**：`待领取 → 执行中 → 待审查 → 已审核 → 已完成`，含 `暂停中` 兜底状态。
- **agent 自动执行**：任务被 agent 领取后自动改码并 `git commit`，无需人工介入。
- **git 分支隔离**：每个任务使用独立任务分支（`kanban/<id前8>`），执行前自动从基础分支切出。
- **审核合并**：人工「审核通过」后自动 `merge --no-ff` 回基础分支并删除任务分支。
- **评论并继续**：待审查状态支持评论，agent 恢复原会话继续修改后重新提交。
- **新建任务配置**：可选执行模型、定时执行时间；基础分支为下拉选择（从项目 git 分支实时获取）。
- **改动记录**：任务详情记录每次 agent 执行后的最终输出全文（改动说明/方案/细节），而非 git 统计。
- **统一工作区**：同一项目的所有看板任务共享同一个「看板任务」工作区分组，不重复创建。

## 架构概览

DSH 是「主机平面 cordis 插件 + 客户端插件」双层架构，本插件对应两个部分：

```
┌───────────────────────────── DSH Web（浏览器） ─────────────────────────────┐
│  lib/client.js（React 外壳）                                                  │
│    ├─ sidebar.footer.action  → 侧边栏「任务看板」入口                          │
│    └─ shell.overlay          → 全屏看板面板，挂载 Vue 应用                     │
│         └─ src/（Vue 3 + Tailwind v4 + shadcn-vue 看板 UI）                    │
│               └─ ctx.remote.kanban.*（Typert Remote 远程调用）                │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼───────────────────────────────────────────┐
│  lib/index.js（主机平面 cordis 插件）                                            │
│  KanbanService extends TypertRemoteService（注册为 ctx.kanban）                  │
│    ├─ 数据：ctx.storageDomain 的 kanban 域（tasks 表）→ ~/.dsh/storages        │
│    ├─ 项目：ctx.workspaceRegistry.list()（与 DSH 工作区绑定）                   │
│    ├─ git：child_process 执行（主机平面，不受沙箱限制）                          │
│    └─ agent：ctx.agents.create + followup + whenIdle                           │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **主机端**（`lib/index.js`）：状态机、git 调度、agent 执行、数据持久化。
- **客户端**（`src/client.ts` + `src/` 看板 UI）：入口注册、看板展示与交互。
- 客户端经 `ctx.remote.kanban.<method>` 调用主机远程方法，看板打开期间约 2s 轮询 `getBoard()`。

## 目录结构

```
.
├── lib/                      # 构建产物（也是插件包体）
│   ├── index.js              # 主机端服务（KanbanService，手写源文件）
│   ├── client.js             # 客户端 bundle（构建生成，ModuleLoader 包装）
│   └── client.raw.js         # vite 中间产物（被 wrap-client 包装）
├── scripts/
│   ├── wrap-client.mjs       # 把 vite CJS 产物包装成 DSH ModuleLoader 格式
│   └── smoke-host.mjs        # 主机端冒烟测试（内存态跑完整任务流转）
├── src/                      # 客户端源码（Vue 3 + shadcn-vue）
│   ├── client.ts             # React 外壳：挂载 Remote、注册侧边栏入口与 overlay
│   ├── kanban-entry.ts       # Vue 应用挂载/卸载
│   ├── remote.ts             # Typert Remote 描述符（远程方法声明）
│   ├── App.vue               # 看板根组件
│   ├── components/           # BoardView / KanbanColumn / TaskCard / TaskDetailSheet
│   │                         #   / NewTaskDialog / SchedulePicker / ui/*(shadcn)
│   ├── composables/useBoard.ts
│   └── lib/                  # bridge.ts（KanbanApi 接口）、types.ts、utils.ts
├── docs/DESIGN.md            # 设计文档（状态机、git 流程、架构细节）
└── package.json
```

## 快速开始

### 环境要求

- Node.js ≥ 22（pnpm 管理依赖）
- 已安装 DSH（`dsh` CLI 可用，含 `web` profile）
- 项目基于 WSL（Ubuntu），以下命令在 WSL 内执行

### 安装依赖

```bash
cd /home/callmesoul/code/deepseek-kanban-plugin
pnpm install
```

### 构建

```bash
pnpm build        # vite build + wrap-client.mjs，生成 lib/client.js
pnpm watch        # 开发时增量构建
```

### 安装到 DSH

**普通用户 / 快速体验（从 GitHub 安装）：**

```bash
dsh plugin --profile web add "github:callmesoul/deepseek-kanban-plugin"
```

**本地开发（`file:` 协议，硬链接实时生效）：**

```bash
# 方式一：直接安装（推荐）
dsh plugin --profile web add "file:$(pwd)"

# 方式二：完整重建 + 重装
pnpm sync:dsh     # 等价于 build + remove + add
```

> ⚠️ `file:` 协议路径必须是 WSL 原生路径（`/home/callmesoul/...`），不要用 `\\wsl.localhost\...` 形式的 Windows 路径，否则 pnpm 会报 `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`。

安装后**重启 / 重载 DSH 应用**（或重载插件）生效。之后侧边栏底部出现「任务看板」入口。

### 冒烟测试

```bash
pnpm test:smoke   # 内存态验证 创建→评论继续→审核→合并 全流程
```

## 使用说明

### 新建任务

1. 点击看板「新建任务」。
2. 选择**项目**（来自 DSH 工作区）；选择项目后自动加载该项目 git 分支，作为**基础分支**下拉选项（默认当前分支）。
3. 填写标题与描述，可选选择**执行模型**与**执行时间**（留空立即执行，未来时间到点由主机端定时器自动领取）。
4. 创建后任务进入「待领取」，agent 自动领取执行。

### 状态流转

```
待领取(todo) ──自动领取──▶ 执行中(running) ──agent完成+commit──▶ 待审查(review)
                            │                                        │
                            └──切分支遇未提交──▶ 暂停中(paused)        │ 用户手动「审核通过」
                                                   │ 用户确认后继续    ▼
                                                   └────────────── 已审核(approved)
                                                                        │ agent 自动合回
                                                                        ▼
                                                                     已完成(done)
```

- **待审查**：可打开详情查看改动记录（agent 最终输出全文）与评论；「审核通过」后自动合并；也可以评论让 agent 继续修改。
- **暂停中**：切换分支时检测到未提交改动，提示用户处理；确认后继续执行。
- **已完成**：任务分支已合并回基础分支并删除。

### git 流程

- 新建任务：记录 `baseBranch`（基础分支）与 `taskBranch`（`kanban/<id前8>`）。
- 执行：`git checkout <base>` → `git checkout -b <taskBranch>` → agent 改码 → `git add -A && git commit`。
- 审核通过：`git checkout <base>` → `git merge --no-ff <taskBranch>` → `git branch -d <taskBranch>` → 状态置为 done。

## 远程 API（ctx.remote.kanban.*）

| 方法 | 说明 |
| --- | --- |
| `listProjects()` | 列出 DSH 工作区（项目）列表 |
| `getBoard()` | 获取看板全量数据（项目 + 任务 + 状态） |
| `listCreateTaskOptions()` | 新建任务选项（模型分组 + 默认模型） |
| `listBranches({ projectId })` | 获取项目 git 分支列表（含当前分支） |
| `createTask(input)` | 新建任务 |
| `moveTask({ taskId, to })` | 移动任务状态 |
| `approveTask({ taskId })` | 审核通过（触发合并） |
| `resumeTask({ taskId })` | 恢复暂停的任务 |
| `commentTask({ taskId, comment })` | 评论并继续（恢复 agent 会话追加 followup） |
| `deleteTask({ taskId })` | 删除任务 |

调用均返回 `{ ok: true, value } | { ok: false, error }`（见 `src/lib/types.ts`）。

## 开发指南

### 新增一个远程方法

1. `lib/index.js`：在 `KanbanService` 添加方法，并加入 `markRemoteMethods` 注册列表。
2. `src/remote.ts`：添加对应 descriptor。
3. `src/lib/bridge.ts`：在 `KanbanApi` 接口补充签名。
4. 重新 `pnpm build` 生成 client.js，重载 DSH 生效。

### 构建与安装注意

- `lib/index.js` 为手写源文件，`lib/client.js` 为构建产物（勿手改）。
- 通过 pnpm `file:` 协议安装后，profile 副本与项目源文件是**硬链接**：`pnpm build` 后源文件即生效，无需手动拷贝；但改 `package.json` 的 `files` 字段或需要彻底重装时，用 `pnpm sync:dsh`。
- 改 host 端或客户端代码后，都需要**重载 DSH 应用/插件**才生效。

## 常见问题

**Q：执行了多个看板任务，为什么会出现多个「看板任务」工作区？**
旧版本每个任务都会新建工作区；已修复为同一项目（按路径匹配）复用同一个「看板任务」工作区分组，新任务直接 attach 到已有分组。

**Q：任务详情里改动记录为空？**
改动记录自「记录 agent 最终输出」版本起生效。历史已完成任务是在旧版本执行的，无法回溯补录；新任务执行后即有记录。

**Q：为什么改了源码不生效？**
确保已执行 `pnpm build` 且已重载 DSH 应用。若仍未生效，可 `pnpm sync:dsh` 重装。

## License

MIT
