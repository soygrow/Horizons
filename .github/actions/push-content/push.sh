#!/usr/bin/env bash
#
# 提交产物并推进远端分支。
#
# 为什么抽出来：这段逻辑原先在 13 个 workflow 里各抄了一份，而且抄错的还不少。
# 最典型的一种是「push 被拒 → rebase origin/main」，但**不先 fetch**：
# 本地那个 remote-tracking ref 还是 checkout 那一刻的，rebase 只会打印
# "Current branch main is up to date."，于是三次重试等于原样试三次，
# 最后一次照样被拒 —— 2026-11-09 那期情报就是这么失败的（产物在 runner 上，
# 远端在这几轮里一直往前跑）。
#
# 现在的规则：
#   1. 每一轮都先 fetch，变基目标永远是刚拉下来的那个提交；
#   2. 冲突只允许出现在产物路径上 —— 这些文件是本次刚重新生成的，取本次这份；
#      非产物路径（别人手改的文案、代码）冲突就 abort 并报错，不猜、不覆盖；
#   3. 退避带抖动，避免两个 run 每次都同时撞在同一个时间点上；
#   4. 派生数据（早已写进 D1）允许 soft-fail：只告警，不让整条流水线红叉。
#
# 环境变量（由 action.yml 从 inputs 传入）：
#   PUSH_PATHS     要提交的路径，空格分隔，如 "content/digest"
#   PUSH_MESSAGE   提交信息
#   PUSH_BRANCH    目标分支，空则用 GITHUB_REF_NAME，再空则 main
#   PUSH_ATTEMPTS  最多尝试次数，默认 6
#   PUSH_SOFT_FAIL "true" 时推送失败不退出非零
#   BOT_NAME / BOT_EMAIL  提交身份，默认 horizons-bot

set -uo pipefail

paths_input="${PUSH_PATHS:-}"
message="${PUSH_MESSAGE:-chore: 产物}"
branch="${PUSH_BRANCH:-}"
attempts="${PUSH_ATTEMPTS:-6}"
soft_fail="${PUSH_SOFT_FAIL:-false}"

if [ -z "$branch" ]; then
  branch="${GITHUB_REF_NAME:-main}"
fi

read -r -a paths <<< "$paths_input"
if [ "${#paths[@]}" -eq 0 ]; then
  echo "::error::push-content 没拿到要提交的路径"
  exit 1
fi

output_file="${GITHUB_OUTPUT:-/dev/null}"

git config user.name "${BOT_NAME:-horizons-bot}"
git config user.email "${BOT_EMAIL:-bot@horizons.tools}"

# 冲突文件是否属于「本次产物」。传的是目录或文件路径，两种都按前缀匹配。
is_product() {
  local file="$1" p
  for p in "${paths[@]}"; do
    case "$file" in
      "$p"|"$p"/*) return 0 ;;
    esac
  done
  return 1
}

rebase_in_progress() {
  local dir
  for dir in rebase-merge rebase-apply; do
    [ -d "$(git rev-parse --git-path "$dir")" ] && return 0
  done
  return 1
}

# 变基到远端。冲突只认产物路径，其余一律放弃。
rebase_onto() {
  local target="$1" guard=0 file bad
  if GIT_EDITOR=true git rebase "$target"; then
    return 0
  fi

  while rebase_in_progress; do
    guard=$((guard + 1))
    if [ "$guard" -gt 20 ]; then
      echo "::error::变基冲突反复出现，已放弃；产物仍在本地提交里，需要人工处理"
      git rebase --abort
      return 1
    fi

    bad=""
    while IFS= read -r file; do
      [ -z "$file" ] && continue
      if is_product "$file"; then
        # 变基过程里 --theirs 是自己那个提交，也就是本次刚生成的内容
        if git checkout --theirs -- "$file"; then
          git add -- "$file"
        else
          bad="${bad}${bad:+ }${file}"
        fi
      else
        bad="${bad}${bad:+ }${file}"
      fi
    done <<< "$(git diff --name-only --diff-filter=U)"

    if [ -n "$bad" ]; then
      echo "::error::变基冲突涉及非产物文件：${bad}；不自动覆盖，请人工处理"
      git rebase --abort
      return 1
    fi

    if ! GIT_EDITOR=true git rebase --continue; then
      rebase_in_progress || break
    fi
  done

  if rebase_in_progress; then
    git rebase --abort
    return 1
  fi
  return 0
}

# 路径可能不存在（例如候选池被手工清理过）。git add 遇到不存在的 pathspec
# 会直接 fatal，这里先过滤掉，全都不在就等同于「没有产物变更」。
existing=()
for p in "${paths[@]}"; do
  [ -e "$p" ] && existing+=("$p")
done

if [ "${#existing[@]}" -eq 0 ]; then
  echo "::notice::没有产物变更（给定路径都不存在）"
  echo "changed=false" >> "$output_file"
  exit 0
fi

git add -- "${existing[@]}"
if git diff --staged --quiet; then
  echo "::notice::没有产物变更"
  echo "changed=false" >> "$output_file"
  exit 0
fi

git commit -q -m "$message"
echo "changed=true" >> "$output_file"
echo "::notice::已提交 $(git rev-parse --short HEAD)：${message}"

# 浅克隆没有共同祖先，变基会直接报 unrelated histories
if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
  git fetch --unshallow --quiet origin "$branch" || true
fi

attempt=1
while [ "$attempt" -le "$attempts" ]; do
  # 关键的一步：每轮都重新取远端。少了这句，下面的变基就是在旧引用上原地打转。
  if ! git fetch --quiet origin "+refs/heads/${branch}:refs/remotes/origin/${branch}"; then
    echo "::warning::取远端 ${branch} 失败（第 ${attempt} 次）"
  fi

  remote="origin/${branch}"
  if git rev-parse --verify --quiet "$remote" >/dev/null; then
    # 只有远端确实在自己的历史之外时才需要变基
    if ! git merge-base --is-ancestor "$remote" HEAD; then
      rebase_onto "$remote" || exit 1
    fi
  fi

  if git push --quiet origin "HEAD:${branch}"; then
    echo "::notice::已推送 $(git rev-parse --short HEAD) 到 ${branch}（第 ${attempt} 次尝试）"
    exit 0
  fi

  echo "::warning::push 被拒（第 ${attempt}/${attempts} 次），稍后重试"
  sleep $(( (2 ** attempt) + RANDOM % 4 ))
  attempt=$((attempt + 1))
done

if [ "$soft_fail" = "true" ]; then
  echo "::warning::连续 ${attempts} 次推送被拒，产物未入仓；数据源已写入数据库，下次运行会重算"
  exit 0
fi

# 真失败时把这次提交留成 patch，由 action.yml 里的 upload-artifact 收走 ——
# 不然产物跟着 runner 一起销毁，只能整期重跑。
if [ -n "${RUNNER_TEMP:-}" ]; then
  mkdir -p "${RUNNER_TEMP}" 2>/dev/null || true
  if git format-patch -1 --binary --stdout > "${RUNNER_TEMP}/push-content.patch" 2>/dev/null; then
    echo "::notice::本次提交已存成 push-content.patch，可从本次运行的产物里取回"
  fi
fi

echo "::error::连续 ${attempts} 次推送被拒，产物未入库；已把本次提交存成 patch 附到本次运行"
exit 1