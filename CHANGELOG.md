# 更新日志

本文件记录项目的重要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

## [0.2.0] - 2026-08-27

### 新增

- 引入 [agent-textarea](https://github.com/callmesoul/agent-textarea) 的 Agent Composer，用于新建任务的描述输入和任务详情的评论输入。
- 支持输入 `@` 搜索并引用当前项目文件或目录，包含键盘选择、异步加载和按项目缓存。
- 支持通过选择、拖放和剪贴板粘贴添加附件，并提供图片预览和附件移除。
- 将附件转换为现有 `file://` Markdown 引用，使主机能够把引用还原为 agent 可读的文件路径。

### 变更

- 评论框改为 Enter 提交、Shift+Enter 换行，并在输入法组合输入期间忽略提交快捷键。
- 项目目录由业务上下文自动注入，不再在任务描述和评论输入框中重复显示。
- 移除 Agent Composer 容器、文件候选浮层和附件移除按钮的阴影。
- 页面输入提示不再展示“支持 Markdown”，仅提示使用 `@` 引用项目文件。
- 将 `@vitejs/plugin-vue` 升级到 6.x，与项目使用的 Vite 6 保持兼容。
- 更新 README 与设计文档，说明 Agent Composer、文件引用、附件和键盘交互。

## [0.1.0] - 2026-08-20

### 新增

- 首次发布 DeepSeek Harness 任务看板插件。
- 提供任务状态机、git 分支调度、agent 自动执行和浏览器看板 UI。
