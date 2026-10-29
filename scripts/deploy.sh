#!/usr/bin/env bash
#
# Horizons 部署入口 —— 唯一部署方式（不要手工散跑 wrangler / opennextjs-cloudflare）
#
# 背景：本项目**没有** Cloudflare Git 自动部署。push 到 origin/main 不会上线，
# 必须由本脚本在本地构建并上传到 Cloudflare Workers。
#
# 拓扑（2026-10-29 起）：
#   horizons-site  apps/site（Astro 静态站）→ 主域 horizons.tools/*   ← 线上正式前端
#   horizons-web   apps/web（旧 Next 站）  → 无路由，仅作回滚备胎
#   horizons-api   apps/api（Hono/D1）     → horizons.tools/api/*
#
# 用法：
#   bash scripts/deploy.sh                # 构建并部署 site + api（默认）
#   bash scripts/deploy.sh site           # 只部署前端 horizons-site
#   bash scripts/deploy.sh api            # 只部署后端 horizons-api
#   bash scripts/deploy.sh web            # 只部署旧 Next 站 horizons-web（回滚用，不带路由）
#   bash scripts/deploy.sh --dry          # 只构建 + 类型检查，不上传（发布前自检）
#   bash scripts/deploy.sh api --migrate  # 部署前先 apply D1 迁移
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGET="all"
DRY=0
MIGRATE=0
for arg in "$@"; do
  case "$arg" in
    site|api|web|all) TARGET="$arg" ;;
    --dry) DRY=1 ;;
    --migrate) MIGRATE=1 ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$arg（可用：site | api | web | all | --dry | --migrate）" >&2; exit 1 ;;
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

for f in content/github.json content/aitools.json; do
  [ -s "$f" ] || { echo "缺少数据文件 $f" >&2; exit 1; }
done
ok "数据文件就绪"

# ---------- 部署函数 ----------

deploy_site() {
  log "生成榜单产物 content/dist（唯一真源：content/*.json）"
  pnpm --filter @horizons/site run data

  if [ "$DRY" = "1" ]; then
    log "构建 horizons-site（Astro，不上传）"
    pnpm --filter @horizons/site run build
  else
    log "构建并部署 horizons-site（Astro → wrangler，主域 horizons.tools/*）"
    pnpm --filter @horizons/site exec wrangler deploy
  fi
  ok "horizons-site 完成"
}

deploy_web() {
  warn "horizons-web 是旧 Next 站（已不绑路由），仅用于回滚"
  if [ "$DRY" = "1" ]; then
    log "构建 horizons-web（OpenNext，不上传）"
    pnpm --filter @horizons/web run opennext:build
  else
    log "构建并部署 horizons-web（OpenNext → wrangler）"
    pnpm --filter @horizons/web run deploy
  fi
  ok "horizons-web 完成"
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
  web) deploy_web ;;
  api) deploy_api ;;
  all) deploy_site; deploy_api ;;
esac

# ---------- 上线验收 ----------

if [ "$DRY" = "1" ]; then
  printf '\n\033[32m✓ 构建自检通过（未上传，用时 %ss）\033[0m\n' "$(( $(date +%s) - started ))"
  exit 0
fi

log "线上验收（$SITE）"
fail=0
for path in / /tools /github /trends; do
  # 部署刚生效时偶尔会拿到 000/5xx，重试两次再判定
  for attempt in 1 2 3; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "$SITE$path" 2>/dev/null || true)
    code=${code:-000}
    [ "$code" = "200" ] && break
    [ "$attempt" -lt 3 ] && sleep 2
  done
  if [ "$code" = "200" ]; then
    ok "$path → 200"
  else
    warn "$path → $code"
    fail=1
  fi
done

# 404 兜底页：必须是 404 且带自定义内容（否则说明 not_found_handling 没生效）
missing=$(curl -s --max-time 60 "$SITE/deploy-check-should-not-exist" 2>/dev/null || true)
if printf '%s' "$missing" | grep -q "这个页面不存在"; then
  ok "/deploy-check-should-not-exist → 自定义 404 页"
else
  warn "/deploy-check-should-not-exist → 未命中自定义 404 页"
  fail=1
fi

printf '\n'
if [ "$fail" = "0" ]; then
  printf '\033[32m✓ 部署完成，用时 %ss\033[0m\n' "$(( $(date +%s) - started ))"
else
  printf '\033[31m✗ 部署已上传，但线上验收未全通过——见上面状态码\033[0m\n'
  echo "  排查：pnpm --filter @horizons/site exec wrangler deployments list"
  exit 1
fi