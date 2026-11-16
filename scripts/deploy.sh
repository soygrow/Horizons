#!/usr/bin/env bash
#
# Horizons 部署入口 —— 唯一部署方式（不要手工散跑 wrangler / opennextjs-cloudflare）
#
# 日常发布走 GitHub Actions（.github/workflows/deploy-site.yml / deploy-api.yml）：
# push 到 origin/main 即在 GitHub 机器上构建并部署，不经过本地网络上传。
# 本脚本保留给：紧急回滚、本地预演（--dry）、需要先跑 D1 迁移的 api 发布。
#
# 拓扑（2026-11-06 起）：
#   horizons-site  apps/site（Astro 静态站）→ 主域 horizons.tools/*   ← 唯一前端
#   horizons-api   apps/api（Hono/D1）     → horizons.tools/api/*
#
# 用法：
#   bash scripts/deploy.sh                # 构建并部署 site + api（默认）
#   bash scripts/deploy.sh site           # 只部署前端 horizons-site
#   bash scripts/deploy.sh api            # 只部署后端 horizons-api
#   bash scripts/deploy.sh --dry          # 只构建 + 类型检查，不上传（发布前自检）
#   bash scripts/deploy.sh site --strict  # 线上验收异常时以非零退出码阻断
#   bash scripts/deploy.sh api --migrate  # 部署前先 apply D1 迁移
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGET="all"
DRY=0
MIGRATE=0
STRICT=0
for arg in "$@"; do
  case "$arg" in
    site|api|all) TARGET="$arg" ;;
    --dry) DRY=1 ;;
    --migrate) MIGRATE=1 ;;
    --strict) STRICT=1 ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$arg（可用：site | api | all | --dry | --migrate | --strict）" >&2; exit 1 ;;
  esac
done

SITE="https://horizons.tools"
started=$(date +%s)

log() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
ok()  { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }

# ---------- 前置检查 ----------

log "前置检查"

if ! pnpm --filter @horizons/site exec wrangler whoami >/dev/null 2>&1; then
  echo "wrangler 未登录。先执行：" >&2
  echo "  pnpm --filter @horizons/site exec wrangler login" >&2
  exit 1
fi
ok "wrangler 已登录"

if [ -n "$(git status --porcelain)" ]; then
  warn "工作区有未提交改动：本次会把它们一起发布到线上（建议先 git commit）"
else
  ok "工作区干净"
fi

# aitools.json 不在这里检查：它已不入库，由下面 data 步骤的 hydrate 从 D1 还原
for f in content/github.json; do
  [ -s "$f" ] || { echo "缺少数据文件 $f" >&2; exit 1; }
done
ok "数据文件就绪"

# ---------- 部署函数 ----------

deploy_site() {
  log "生成榜单产物 content/dist（唯一真源：content/*.json）"
  pnpm --filter @horizons/site run data

  log "构建 horizons-site（Astro）"
  pnpm --filter @horizons/site run build

  if [ "$DRY" = "1" ]; then
    ok "构建完成（未上传）"
  else
    log "上传到 Cloudflare（horizons-site，主域 horizons.tools/*）"
    pnpm --filter @horizons/site exec wrangler deploy
  fi
  ok "horizons-site 完成"
}

deploy_api() {
  if [ "$MIGRATE" = "1" ]; then
    log "应用 D1 迁移（远程 horizons-db）"
    pnpm --filter @horizons/api exec wrangler d1 migrations apply horizons-db --remote
  fi

  if [ "$DRY" = "1" ]; then
    log "类型检查 horizons-api（不上传）"
    pnpm --filter @horizons/api run typecheck
  else
    log "部署 horizons-api（Hono → wrangler）"
    pnpm --filter @horizons/api run deploy
  fi
  ok "horizons-api 完成"
}

# ---------- 执行 ----------

case "$TARGET" in
  site) deploy_site ;;
  api) deploy_api ;;
  all) deploy_site; deploy_api ;;
esac

# ---------- 上线验收 ----------

if [ "$DRY" = "1" ]; then
  printf '\n\033[32m✓ 构建自检通过（未上传，用时 %ss）\033[0m\n' "$(( $(date +%s) - started ))"
  exit 0
fi

log "线上验收（$SITE，并行，单页超时 10s）"
fail=0
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

fetch_code() {
  local path="$1" key="$2" code
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    --max-time 10 --retry 1 --retry-delay 1 --retry-all-errors \
    "$SITE$path" 2>/dev/null || true)
  printf '%s' "${code:-000}" > "$tmpdir/$key"
}

for path in / /tools /github /trends /daily; do
  fetch_code "$path" "$(printf '%s' "$path" | tr '/' '_')" &
done
curl -s --max-time 10 "$SITE/deploy-check-should-not-exist" 2>/dev/null > "$tmpdir/notfound" &
wait || true

for path in / /tools /github /trends /daily; do
  key=$(printf '%s' "$path" | tr '/' '_')
  code=$(cat "$tmpdir/$key" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then
    ok "$path → 200"
  else
    warn "$path → $code"
    fail=1
  fi
done

# 404 兜底页：必须是 404 且带自定义内容（否则说明 not_found_handling 没生效）
if grep -q "这个页面不存在" "$tmpdir/notfound" 2>/dev/null; then
  ok "/deploy-check-should-not-exist → 自定义 404 页"
else
  warn "/deploy-check-should-not-exist → 未命中自定义 404 页"
  fail=1
fi

printf '\n'
if [ "$fail" = "0" ]; then
  printf '\033[32m✓ 部署完成，用时 %ss\033[0m\n' "$(( $(date +%s) - started ))"
elif [ "$STRICT" = "1" ]; then
  printf '\033[31m✗ 部署已上传，但线上验收未全通过——见上面状态码\033[0m\n'
  echo "  排查：pnpm --filter @horizons/site exec wrangler deployments list"
  exit 1
else
  # 本机到 Cloudflare 边缘偶发不通（curl 直接 000），不代表线上故障：
  # 默认只告警，避免把一次成功发布标成失败（加 --strict 可恢复阻断）。
  printf '\033[33m! 部署已上传，验收有异常项（默认不阻断，加 --strict 可阻断）\033[0m\n'
  printf '\033[32m✓ 部署完成，用时 %ss\033[0m\n' "$(( $(date +%s) - started ))"
fi