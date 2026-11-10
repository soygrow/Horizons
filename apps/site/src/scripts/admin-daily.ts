/**
 * 后台「每日情报」页签。
 *
 * 这里不跑任何采集：所有环节都 dispatch 到 GitHub Actions（daily.yml）。
 * 原因见 admin-daily 路由的注释 —— 本地到 reddit、bbc 等源不通，采出来会
 * 悄悄少几十条，且不报错。
 *
 * 页签只做三件事：看这一期收了什么、触发采集/成稿/入库、确认跑完没有。
 */
import { $, apiGet, apiPost, esc, fmtTime } from "./admin-shared";

/* --------------------------------- 类型 --------------------------------- */

interface Issue {
  date: string;
  generatedAt: string | null;
  total: number;
  modules: Record<string, number>;
  top: string[];
  error?: string;
}

interface IssuesRes {
  issues: Issue[];
}

interface RunStatusRes {
  status: string;
  run: { id: number; url: string; status: string; conclusion: string | null } | null;
}

/* -------------------------------- 常量 --------------------------------- */

const BTN =
  "rounded-lg border px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-60";

/** 成稿里的书写顺序：头条 → 能用 → 钱 → 能做 */
const MODULE_ORDER = ["headline", "tools", "money", "action"] as const;

const MODULE_LABEL: Record<string, string> = {
  headline: "头条",
  tools: "能用",
  money: "钱",
  action: "能做",
};

const STATUS_LABEL: Record<string, string> = {
  idle: "未运行",
  queued: "排队中",
  running: "运行中",
  success: "已完成",
  failed: "失败",
};

let mounted = false;
let pollTimer: number | null = null;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function setStatus(text: string, tone: "idle" | "busy" | "ok" | "bad" = "idle"): void {
  const el = $("daily-status");
  if (!el) return;
  el.textContent = text;
  el.className =
    tone === "bad"
      ? "text-xs text-red-600"
      : tone === "ok"
        ? "text-xs text-emerald-600"
        : tone === "busy"
          ? "text-xs text-amber-600"
          : "text-xs text-slate-500";
}

/* -------------------------------- 渲染 --------------------------------- */

function moduleCells(issue: Issue): string {
  return MODULE_ORDER.map((key) => {
    const n = issue.modules[key] ?? 0;
    // 0 条要显眼：钱与机会空着通常意味着当天真的没有商业信号
    return `<td class="px-2 py-1.5 text-center ${n === 0 ? "text-slate-300" : "text-slate-700"}">${n}</td>`;
  }).join("");
}

function renderIssues(issues: Issue[]): void {
  const body = $("daily-list");
  if (!body) return;

  if (!issues.length) {
    body.innerHTML = `<tr><td colspan="7" class="px-3 py-6 text-center text-xs text-slate-400">还没有任何一期</td></tr>`;
    return;
  }

  body.innerHTML = issues
    .map((issue) => {
      const top = issue.top.length
        ? issue.top
            .map((t) => `<div class="truncate text-xs text-slate-600" title="${esc(t)}">${esc(t)}</div>`)
            .join("")
        : `<span class="text-xs text-slate-300">—</span>`;

      return `<tr class="border-t border-slate-100">
        <td class="px-2 py-2 font-mono text-xs text-slate-700">${esc(issue.date)}</td>
        ${moduleCells(issue)}
        <td class="px-2 py-1.5 text-center text-xs font-medium text-slate-700">${issue.total}</td>
        <td class="max-w-md px-2 py-2">${top}</td>
      </tr>`;
    })
    .join("");
}

async function loadIssues(): Promise<void> {
  const body = $("daily-list");
  if (!body) return;
  try {
    const res = await apiGet<IssuesRes>("/daily/issues?limit=8");
    renderIssues(res?.issues ?? []);
  } catch (e) {
    body.innerHTML = `<tr><td colspan="7" class="px-3 py-4 text-center text-xs text-red-600">读取失败：${esc(msg(e))}</td></tr>`;
  }
}

/* -------------------------------- 状态 --------------------------------- */

async function refreshStatus(): Promise<void> {
  try {
    const res = await apiGet<RunStatusRes>("/daily/run-status");
    const label = STATUS_LABEL[res?.status] ?? res?.status ?? "未知";
    const link = res?.run?.url
      ? ` · <a class="underline" href="${esc(res.run.url)}" target="_blank" rel="noreferrer">查看日志</a>`
      : "";
    const tone = res?.status === "failed" ? "bad" : res?.status === "success" ? "ok" : res?.status === "idle" ? "idle" : "busy";
    const el = $("daily-status");
    if (el) {
      el.innerHTML = `最近一次运行：${esc(label)}${link}`;
      el.className =
        tone === "bad"
          ? "text-xs text-red-600"
          : tone === "ok"
            ? "text-xs text-emerald-600"
            : tone === "busy"
              ? "text-xs text-amber-600"
              : "text-xs text-slate-500";
    }
  } catch (e) {
    setStatus(`状态读取失败：${msg(e)}`, "bad");
  }
}

/** 触发后轮询几次，等 workflow 从 queued 转成 running/success */
function pollStatus(times = 6): void {
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  if (times <= 0) return;
  pollTimer = window.setTimeout(async () => {
    await refreshStatus();
    pollStatus(times - 1);
  }, 5000);
}

/* -------------------------------- 触发 --------------------------------- */

async function run(mode: "fetch" | "build" | "publish" | "all", label: string): Promise<void> {
  const input = $("daily-date") as HTMLInputElement | null;
  const date = input?.value.trim() ?? "";

  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    setStatus("日期格式应为 YYYY-MM-DD，留空表示今天", "bad");
    return;
  }

  const buttons = ["daily-run-fetch", "daily-run-build", "daily-run-publish"] as const;
  for (const id of buttons) {
    const btn = $(id) as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
  }

  setStatus(`正在触发${label}…`, "busy");
  try {
    await apiPost("/daily/run", { mode, date });
    setStatus(`${label}已提交到 GitHub Actions，正在等待启动…`, "busy");
    pollStatus(8);
    // 采集要一两分钟，先给个短延迟再刷列表
    window.setTimeout(() => void loadIssues(), 90_000);
  } catch (e) {
    setStatus(`${label}触发失败：${msg(e)}`, "bad");
  } finally {
    for (const id of buttons) {
      const btn = $(id) as HTMLButtonElement | null;
      if (btn) btn.disabled = false;
    }
  }
}

/* -------------------------------- 挂载 --------------------------------- */

export function mountAdminDaily(): void {
  if (mounted) return;
  mounted = true;

  const bind = (id: string, mode: "fetch" | "build" | "publish" | "all", label: string): void => {
    const btn = $(id);
    if (!btn) return;
    btn.className = `${BTN} border-slate-300 bg-white text-slate-700 hover:bg-slate-50`;
    btn.addEventListener("click", () => void run(mode, label));
  };

  bind("daily-run-fetch", "fetch", "采集");
  bind("daily-run-build", "build", "成稿");
  bind("daily-run-publish", "all", "采集→成稿→入库");

  $("daily-refresh")?.addEventListener("click", () => {
    void loadIssues();
    void refreshStatus();
  });

  void refreshStatus();
  void loadIssues();
}

/** 供页面切换时复用（不重复挂载，只刷新数据） */
export function refreshAdminDaily(): void {
  if (!mounted) return;
  void loadIssues();
  void refreshStatus();
}