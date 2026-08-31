#!/usr/bin/env bash
# deploy-local.sh — 一键部署插件到本地宿主（file: 模式）并修复 peer 双实例坑。
#
# 背景：pnpm 装插件会把 peer 依赖（@deepseek-ai/*、zod）装成插件内部独立拷贝，
# 与全局 dsh 宿主是不同模块实例，导致 typert Remote marker 的 WeakMap
# 不共享、SRC claims 全空、所有 /api/* 404。必须在每次 pnpm 重装后把插件内部
# 的 @deepseek-ai / zod 指回全局 DSH 的同一份。
#
# 用法：在 WSL 内执行  bash scripts/deploy-local.sh
set -euo pipefail

export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

PROJECT_DIR="/home/callmesoul/code/deepseek-kanban-plugin"
PROFILE_DIR="$HOME/.dsh/profiles/web"
GLOBAL_DSH_DIR="$(npm root -g)/@deepseek-ai/dsh"
GLOBAL_DSH_PEERS="$GLOBAL_DSH_DIR/node_modules"

if [[ ! -d "$GLOBAL_DSH_PEERS/@deepseek-ai" || ! -d "$GLOBAL_DSH_PEERS/zod" ]]; then
  echo "找不到全局 DSH peer 依赖目录：$GLOBAL_DSH_PEERS" >&2
  exit 1
fi

cd "$PROJECT_DIR"
echo "[1/4] pnpm build ..."
pnpm build >/dev/null

echo "[2/4] 重新安装插件到 profile（file: 复制）..."
pnpm --dir "$PROFILE_DIR" remove @deepseek-kanban/plugin >/dev/null
pnpm --dir "$PROFILE_DIR" add "file:$PROJECT_DIR" >/dev/null

echo "[3/4] 修复 peer 双实例（symlink 指回全局 DSH）..."
# file: 复制不带 node_modules；手动建插件内部 node_modules 并让 peer 指向全局 DSH 的
# 同一份（否则插件与 dsh 各加载一份 dsh-typert-protocol，Remote marker 不共享 → /api/* 404）。
PLUGIN_NM="$PROFILE_DIR/node_modules/@deepseek-kanban/plugin/node_modules"
mkdir -p "$PLUGIN_NM"
ln -sfn "$GLOBAL_DSH_PEERS/@deepseek-ai" "$PLUGIN_NM/@deepseek-ai"
ln -sfn "$GLOBAL_DSH_PEERS/zod" "$PLUGIN_NM/zod"

echo "[4/4] 重启 dsh-web 并自检 RPC ..."
systemctl --user restart dsh-web
sleep 3
systemctl --user is-active dsh-web

RESP=$(curl -s -X POST http://127.0.0.1:3080/api/kanban/getBoard -H "Content-Type: application/json" \
  -d '{"type":"client-request","rpcId":"deploy-check","method":"kanban/getBoard","payload":{"args":{}}}')
echo "getBoard RPC: $RESP" | head -c 200
echo
case "$RESP" in
  *'"ok":true'*) echo "✅ 部署成功：kanban API 正常" ;;
  *) echo "❌ 部署失败：kanban API 异常，请检查" ; exit 1 ;;
esac
