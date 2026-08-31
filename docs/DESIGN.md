# DeepSeek Harness 任务看板插件 — 设计

## 目标

在 DSH Web（http://127.0.0.1:3080）左侧侧边栏加入「任务看板」入口，点击后显示当前项目的看板。
看板用 shadcn-vue 实现。任务绑定 DSH 工作区（项目）与 git 分支，由 agent 自动执行。

## 状态机

```
待领取(todo) ──自动领取──▶ 执行中(running) ──agent完成+commit──▶ 待审查(review)
                            │                                          │
                            └──切分支遇未提交──▶ 暂停中(paused)          │ 用户手动「审核通过」
                                                   │ 用户确认后继续      ▼
                                                   └──────────────── 已审核(approved)
                                                                         │ agent 自动合回
                                                                         ▼
                                                                      已完成(done)
```

状态：`todo`(待领取) / `running`(执行中) / `paused`(暂停中) / `review`(待审查) / `approved`(已审核) / `done`(已完成)。

待审查（`review`）状态支持「评论并继续」：用户在任务详情中提交评论后，看板会通过
`ctx.agents.resume({ resumeSessionId })` 恢复原 agent 会话并追加一条 followup，agent 继续
修改后自动提交，任务回到「待审查」等待再次确认。

## 架构

DSH 是「主机平面 cordis 插件 + 客户端 React 插件」双层架构，本插件分三包：

- `packages/core` — 主机插件 `@deepseek-kanban/core`：
  - `KanbanService extends TypertRemoteService`，注册为 `ctx.kanban`（客户端经 `ctx.remote.kanban` 调用）。
  - 数据落 `ctx.storageDomain` 的 `kanban` 域（tasks 表），持久化于 `$DSH_HOME/storages`。
  - 项目 = `ctx.workspaceRegistry.list()`（与工作区同步绑定）。
  - git 操作用 `child_process`（主机平面，不受沙箱限制）。
- agent 执行用 `ctx.agents.create({ meta:{cwd, agentPreset:'standard'} })` + `agent.followup()` + `whenIdle()`。
- agent 会话会写入任务标题，并把会话挂到名为「看板任务」的工作区分组下，避免散落到「未分组」。
- `packages/client` — 客户端插件 `@deepseek-kanban/client`（React）：
  - 注册 `sidebar.footer.action`（侧边栏入口）与 `shell.overlay`（全屏看板面板）。
  - 面板内挂载 Vue 应用（shadcn-vue 看板）。
- `packages/kanban-ui` — Vue 3 + Vite + Tailwind v4 + shadcn-vue 的看板 SPA，构建为单包。

## git 流程

- 新建任务：记录 `baseBranch`（默认当前分支）与 `taskBranch`（`kanban/<id前8>`）。
- 新建任务还可选择执行模型与执行时间：模型默认取 DSH 默认模型；执行时间留空立即执行，未来时间由主机端定时器到点后自动领取。
- 执行：`git checkout <base>` → `git checkout -b <taskBranch>` → agent 改码 → `git add -A && git commit`。
- 切分支前若有未提交改动（`git status --porcelain` 非空）→ 任务 `paused`，提示「分支有未提交的代码」。
- 审核通过后：在基础分支执行 `git merge --no-ff <taskBranch>`；失败时捕获冲突文件并 `git merge --abort`，任务进入 `paused`，主仓库保持干净。
- 冲突恢复：在任务 worktree 合入最新基础分支 → Agent 解决冲突 → 系统校验并提交 → 返回 `review`；再次审核通过后合回基础分支并清理任务 worktree/分支。

## 客户端↔主机

- 客户端通过 `ctx.remote.kanban.<method>` 调用主机远程方法（Typert Remote）。
- 看板实时性：面板打开期间轮询 `getBoard()`（约 2s），避免引入事件推送复杂度。

## 文件引用（`@` 触发）

- 触发点：新建任务的「任务描述」与任务详情的「评论」输入框，输入 `@` 时弹出项目文件/目录候选。
- 主机端 `listProjectPaths({ projectId })`：git 项目优先走 `git ls-files --cached --others --exclude-standard`（快、尊重 .gitignore）；非 git 项目或 git 失败时回退带深度/数量上限的目录扫描（跳过 `.git`/`node_modules`/`dist` 等）。
- 客户端使用 `AgentComposer`：按文件名和路径排序候选，支持 ↑/↓ 循环、Enter/Tab 选中、Esc 关闭，并按项目缓存路径列表。
- 附件选择、拖放或粘贴由 `AgentComposer` 收集；提交时转换成现有 `file://` Markdown 引用，主机在构建 agent 提示词时还原为文件路径。

## 待确认（研究子代理返回后收敛）

- 客户端 bundle 构建格式（`window.__ModuleLoader__.load` CJS factory + react/@deepseek-ai 外部化）。
- Vue-in-React 挂载与 Tailwind 样式隔离。
- agent preset 挂载字段与默认模型。
