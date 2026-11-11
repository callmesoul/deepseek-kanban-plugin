#!/usr/bin/env bash
# deploy-local.sh — 一键部署插件到本机 DSH 宿主（file: 模式）。
#
# DSH 0.2.x 起，profile 内插件与本机 DSH 安装树共享同一份 @deepseek-ai/* 与 zod
# （由 app-boot 的运行时解析器统一路由），因此不再需要旧版脚本里手工 `ln -sfn`
# 指回全局依赖的做法 —— 那套做法针对的是 0.1.x 的独立 node_modules 布局。
#
# 本脚本只是 scripts/sync-dsh.mjs 的薄包装：真正的安装逻辑（CLI 探测、UNC 中转、
# 版本校验）都在那里，跨平台（Windows 桌面版 / WSL / macOS）共用一份。
#
# 用法：
#   bash scripts/deploy-local.sh                # 构建 + 装进 desktop profile
#   bash scripts/deploy-local.sh --profile web  # 装进其他 profile
#   bash scripts/deploy-local.sh -h             # 查看全部选项
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

echo "[1/2] pnpm build ..."
pnpm build

# Windows 版 pnpm 装的是 Windows 路径下的 file: 依赖，因此在 WSL 里必须调用
# Windows 侧的 node 来跑安装脚本；纯 Linux 环境则直接用本机的 node。
NODE_BIN="$(command -v node)"
if [[ "$(uname -r)" == *[Mm]icrosoft* ]] && command -v node.exe >/dev/null 2>&1; then
  NODE_BIN="$(command -v node.exe)"
  SCRIPT_PATH="$(wslpath -w "$PROJECT_DIR/scripts/sync-dsh.mjs")"
  echo "[2/2] 通过 Windows 侧 node 安装到 DSH profile ..."
else
  SCRIPT_PATH="$PROJECT_DIR/scripts/sync-dsh.mjs"
  echo "[2/2] 安装到 DSH profile ..."
fi

"$NODE_BIN" "$SCRIPT_PATH" "$@"
