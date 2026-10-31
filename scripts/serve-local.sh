#!/usr/bin/env bash
#
# Horizons 本地部署入口 —— 唯一本地部署方式（不要散跑 astro dev / next start）
#
# 目标：一条命令得到「和线上同一份构建产物」的本地站点，页面永远是最新代码。
# 固定要素（保证每次结果一致）：
#   端口 4321、产物目录 apps/site/dist、日志 .local/、每次全量重建 dist。
#
# 用法：
#   bash scripts/serve-local.sh              # 重算数据 → 全量构建 → 重启本地服务 → 验收
#   bash scripts/serve-local.sh --port 4330  # 换端口（默认 4321）
#   bash scripts/serve-local.sh --no-build   # 不动代码，只重启服务（产物已是最新时用）
#   bash scripts/serve-local.sh --stop       # 停掉本地服务
#
# 退出码：0 = 本地站点已就绪且验收通过；非 0 = 失败（日志见 .local/）
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT=4321
BUILD=1
STOP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:?--port 需要端口号}"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    --stop) STOP=1; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1（可用：--port <n> | --no-build | --stop）" >&2; exit 1 ;;
  esac
done

DIST="$ROOT/apps/site/dist"
STATE="$ROOT/.local"
SERVER="$ROOT/scripts/local/static-server.mjs"
LOG="$STATE/server.log"
BUILD_LOG="$STATE/build.log"
PID_FILE="$STATE/server.pid"
LOCK="$STATE/deploy.lock"
mkdir -p "$STATE"

started=$(date +%s)
log() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
ok()  { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

port_pids() { lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true; }

stop_server() {
  local pids
  pids="$(port_pids)"
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      [ -z "$(port_pids)" ] && break
      sleep 0.2
    done
    pids="$(port_pids)"
    # shellcheck disable=SC2086
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
    ok "已停止旧服务（端口 $PORT）"
  fi
  rm -f "$PID_FILE"
}

if [ "$STOP" = "1" ]; then
  stop_server
  ok "本地服务已停止"
  exit 0
fi

# ---------- 前置检查 ----------
log "前置检查"
command -v pnpm >/dev/null 2>&1 || die "未找到 pnpm"

# 同一时间只允许一个本地部署：并发构建会互相覆盖 dist，导致“只部署了一部分页面”
if ! mkdir "$LOCK" 2>/dev/null; then
  holder="$(cat "$LOCK/pid" 2>/dev/null || echo '?')"
  die "另一个本地部署正在进行（pid $holder，锁 $LOCK）。若确认已无进程，删除该目录后重试"
fi
echo $$ >"$LOCK/pid"
cleanup_lock() { rm -rf "$LOCK"; }
trap cleanup_lock EXIT INT TERM

# 等外部（手动 / 其他终端）的 astro build 跑完，避免它把 dist 写成半成品。
# 只等会写 apps/site/dist 的进程；apps/web 的 next-build 与本地产物无关，不等。
wait_external_builds() {
  local busy
  busy="$(pgrep -f 'astro[^ ]* .*build' 2>/dev/null | grep -v "^$$\$" || true)"
  [ -z "$busy" ] && return 0
  warn "检测到其他 astro build 进程（pid $(echo "$busy" | tr '\n' ' ')），等待其结束…"
  for _ in $(seq 1 90); do
    busy="$(pgrep -f 'astro[^ ]* .*build' 2>/dev/null | grep -v "^$$\$" || true)"
    [ -z "$busy" ] && { ok "其他构建已结束"; return 0; }
    sleep 1
  done
  die "其他 astro build 进程 90s 未结束，先手动结束它再重试"
}
if [ "$BUILD" = "1" ]; then
  wait_external_builds
fi
[ -d "$ROOT/node_modules" ] || die "依赖未安装：先在仓库根执行 pnpm install"
for f in content/aitools.json content/github.json content/trends.json; do
  [ -s "$f" ] || die "缺少数据文件 $f"
done
ok "依赖与数据文件就绪"

# ---------- 构建（每次全量重建，杜绝残留旧页面） ----------
if [ "$BUILD" = "1" ]; then
  log "生成榜单产物 content/dist（唯一真源：content/*.json）"
  if ! pnpm --filter @horizons/site run data >"$BUILD_LOG" 2>&1; then
    tail -40 "$BUILD_LOG" >&2
    die "数据生成失败，完整日志：$BUILD_LOG"
  fi
  ok "数据产物已生成"

  log "全量重建 horizons-site（清空 dist 后 astro build）"
  rm -rf "$DIST"
  if ! pnpm --filter @horizons/site run build >>"$BUILD_LOG" 2>&1; then
    tail -60 "$BUILD_LOG" >&2
    die "构建失败，完整日志：$BUILD_LOG"
  fi
  ok "构建完成"
else
  [ -f "$DIST/index.html" ] || die "dist 为空，去掉 --no-build 先构建一次"
  warn "跳过数据生成与构建（--no-build）"
fi

# ---------- 产物完整性断言（防止“只部署了一部分页面”） ----------
log "产物完整性检查"
require_page() {
  [ -f "$DIST/$1" ] || die "缺少页面产物：dist/$1（构建不完整）"
}
for p in index.html tools/index.html github/index.html trends/index.html daily/index.html 404.html; do
  require_page "$p"
done
html_count=$(find "$DIST" -name '*.html' | wc -l | tr -d ' ')
[ "$html_count" -ge 200 ] || die "HTML 页面只有 $html_count 个，明显少于预期（详情页未生成？）"
ok "关键页面齐全，HTML 共 $html_count 个"

# ---------- 启动本地服务 ----------
log "启动本地服务（端口 $PORT）"
stop_server
: >"$LOG"
nohup node "$SERVER" "$DIST" "$PORT" >>"$LOG" 2>&1 &
echo $! >"$PID_FILE"

ready=0
for _ in $(seq 1 50); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PORT/" 2>/dev/null || true)" = "200" ]; then
    ready=1
    break
  fi
  sleep 0.2
done
if [ "$ready" != "1" ]; then
  tail -20 "$LOG" >&2
  die "本地服务未在 10s 内就绪，日志：$LOG"
fi
ok "服务已启动（pid $(cat "$PID_FILE")，日志 $LOG）"

# ---------- 验收（与 deploy.sh 同一套页面清单） ----------
log "本地验收"
fail=0
check() {
  local path="$1" expect="$2" code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT$path" 2>/dev/null || true)
  if [ "$code" = "$expect" ]; then ok "$path → $code"; else warn "$path → ${code:-000}（期望 $expect）"; fail=1; fi
}
for p in / /tools /github /trends /daily; do check "$p" 200; done
check /local-deploy-should-not-exist 404

# 404 必须是站点自定义页，不能是空响应
if curl -s --max-time 5 "http://127.0.0.1:$PORT/local-deploy-should-not-exist" 2>/dev/null | grep -q "这个页面不存在"; then
  ok "自定义 404 页生效"
else
  warn "自定义 404 页未命中"
  fail=1
fi

printf '\n'
if [ "$fail" = "0" ]; then
  printf '\033[32m✓ 本地部署完成：http://localhost:%s（用时 %ss）\033[0m\n' "$PORT" "$(( $(date +%s) - started ))"
else
  printf '\033[33m! 本地部署完成，但验收有异常项：http://localhost:%s\033[0m\n' "$PORT"
  exit 1
fi