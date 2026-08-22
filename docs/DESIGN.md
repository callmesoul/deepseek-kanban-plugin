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
- 审核通过后：`git checkout <base>` → `git merge --no-ff <taskBranch>` → `git branch -d <taskBranch>` → `done`。

## 客户端↔主机

- 客户端通过 `ctx.remote.kanban.<method>` 调用主机远程方法（Typert Remote）。
- 看板实时性：面板打开期间轮询 `getBoard()`（约 2s），避免引入事件推送复杂度。

## 路径补全（`/` 触发）

- 触发点：新建任务的「任务描述」与任务详情的「评论」输入框，输入 `/`（且 token 以 `/` 开头）时弹出项目文件/目录补全浮层。
- 主机端 `listProjectPaths({ projectId })`：git 项目优先走 `git ls-files --cached --others --exclude-standard`（快、尊重 .gitignore）；非 git 项目或 git 失败时回退带深度/数量上限的目录扫描（跳过 `.git`/`node_modules`/`dist` 等）。
- 客户端 `usePathAutocomplete`（`src/composables/`）：光标定位用 mirror div 测量像素，浮层绝对定位在 textarea 的 relative 父容器内跟随光标；键盘 ↑/↓ 循环、Enter/Tab 选中、Esc 关闭；目录选中自动追加 `/` 并继续下钻；模块级路径缓存（同一项目只拉取一次）。
- 注意事项：composable 返回给模板使用的状态需用 `reactive()` 包装——普通对象里的 ref 在 Vue 模板中不会自动解包，会以 `RefImpl` 传入子组件 `Boolean` 类型 prop 恒为 true。

## 待确认（研究子代理返回后收敛）

- 客户端 bundle 构建格式（`window.__ModuleLoader__.load` CJS factory + react/@deepseek-ai 外部化）。
- Vue-in-React 挂载与 Tailwind 样式隔离。
- agent preset 挂载字段与默认模型。
