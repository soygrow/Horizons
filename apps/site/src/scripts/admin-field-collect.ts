/**
 * 后台「新采集」tab。
 *
 * 这个页签只做两件事：把地址丢给 GitHub Actions，和把结果页的入口列出来。
 * 真正的采集逻辑在 scripts/field-collect/ 里（Worker 跑不了 Playwright + Apify），
 * 页面不碰任何字段数据 —— 字段展示在独立的 /field-collect?id=xxx 页面。
 *
 * 轮询策略：只在「有任务在排队/采集中」时每 5 秒拉一次列表，全部结束就停；
 * 一次采集通常 2~5 分钟（Similarweb 三个 Actor + 两个 SERP），前端不该空转刷一整天。
 */
import { $, apiGet, apiPost, esc, fmtTime } from "./admin-shared";

interface RunSummary {
  id: string;
  url: string;
  domain: string;
  status: string;
  step: string | null;
  filled: number;
  total: number;
  ghRunId: number | null;
  runUrl: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ListResp {
  runs: RunSummary[];
  totalFields: number;
}

const STATUS_TEXT: Record<string, string> = {
  queued: "排队中",
  running: "采集中",
  success: "已完成",
  failure: "失败",
  cancelled: "已取消",
};

const STATUS_CLASS: Record<string, string> = {
  queued: "text-ink-muted",
  running: "text-primary",
  success: "text-success",
  failure: "text-danger",
  cancelled: "text-ink-muted",
};

let mounted = false;
let pollTimer: number | null = null;

function statusBadge(run: RunSummary): string {
  const text = STATUS_TEXT[run.status] ?? run.status;
  const cls = STATUS_CLASS[run.status] ?? "text-ink-secondary";
  const step = run.step && run.status === "running" ? ` · ${run.step}` : "";
  return `<span class="${cls} font-medium">${esc(text)}</span><span class="text-ink-muted">${esc(step)}</span>`;
}

function progressText(run: RunSummary): string {
  if (!run.total) return "—";
  const pct = Math.round((run.filled / run.total) * 100);
  return `${run.filled}/${run.total}（${pct}%）`;
}

function renderRow(run: RunSummary): string {
  const detail = `/field-collect?id=${encodeURIComponent(run.id)}`;
  const runLink = run.runUrl
    ? `<a href="${esc(run.runUrl)}" target="_blank" rel="noreferrer" class="text-ink-muted underline decoration-dotted hover:text-primary">日志</a>`
    : `<span class="text-ink-muted">—</span>`;
  const hasResult = run.status === "success" || run.filled > 0;
  const view = hasResult
    ? `<a href="${detail}" class="rounded-lg border border-border px-2.5 py-1 text-xs text-ink-secondary transition hover:border-primary hover:text-primary">查看字段</a>`
    : `<span class="text-ink-muted text-xs">—</span>`;

  return `<tr class="border-t border-border/60 align-top">
    <td class="whitespace-nowrap px-3 py-2 text-xs text-ink-muted">${esc(fmtTime(run.createdAt))}</td>
    <td class="px-3 py-2">
      <div class="text-sm">${esc(run.domain)}</div>
      <div class="truncate text-[11px] text-ink-muted max-w-[280px]">${esc(run.url)}</div>
      ${run.error ? `<div class="mt-1 text-[11px] text-danger">${esc(run.error.slice(0, 160))}</div>` : ""}
    </td>
    <td class="px-3 py-2 text-xs">${statusBadge(run)}</td>
    <td class="whitespace-nowrap px-3 py-2 text-xs text-ink-secondary">${esc(progressText(run))}</td>
    <td class="whitespace-nowrap px-3 py-2 text-xs">${runLink}</td>
    <td class="whitespace-nowrap px-3 py-2 text-right">${view}</td>
  </tr>`;
}

async function loadRuns(): Promise<void> {
  const body = $("ncol-body");
  const empty = $("ncol-empty");
  const note = $("ncol-note");
  try {
    const data = await apiGet<ListResp>("/field-collect");
    const runs = data.runs ?? [];
    body.innerHTML = runs.map(renderRow).join("");
    empty.hidden = runs.length > 0;

    const active = runs.filter((r) => r.status === "queued" || r.status === "running");
    if (active.length) {
      note.textContent = `正在采集 ${active.length} 个网站（${active.map((r) => r.domain).join("、")}）。字段采集含 3 个 Similarweb Actor，通常 2~5 分钟。`;
      schedulePoll();
    } else {
      note.textContent =
        "点「开始采集」会触发 GitHub Actions，在云端把文档里的 72 个字段跑一遍（含 PC / 手机截图）。采集约 2~5 分钟，完成后点「查看字段」。";
      stopPoll();
    }
  } catch (e) {
    note.textContent = `记录加载失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

function stopPoll(): void {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function schedulePoll(): void {
  if (pollTimer) return;
  pollTimer = window.setInterval(() => {
    // tab 切走时不再请求：面板虽然 hidden，定时器不会自己停
    const panel = document.getElementById("tab-newcollect");
    if (panel?.hidden) {
      stopPoll();
      return;
    }
    void loadRuns();
  }, 5000);
}

async function startCollect(e: Event): Promise<void> {
  e.preventDefault();
  const input = $<HTMLInputElement>("ncol-url");
  const button = $<HTMLButtonElement>("ncol-start");
  const note = $("ncol-note");

  const url = input.value.trim();
  if (!url) {
    note.textContent = "请输入要采集的网站地址。";
    input.focus();
    return;
  }

  button.disabled = true;
  button.textContent = "提交中…";
  note.textContent = "正在触发 GitHub Actions…";
  try {
    await apiPost<{ run: RunSummary | null }>("/field-collect", { url });
    input.value = "";
    note.textContent = "已提交，采集开始。下方记录会每 5 秒自动刷新。";
    await loadRuns();
  } catch (err) {
    note.textContent = `触发失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    button.disabled = false;
    button.textContent = "开始采集";
  }
}

/** 幂等挂载：tab 每次切回来都会调用，事件只绑一次、定时器不叠加 */
export function mountNewCollect(): void {
  if (!mounted) {
    mounted = true;
    const form = $<HTMLFormElement>("ncol-form");
    form.addEventListener("submit", (e) => void startCollect(e));
    $("ncol-reload").addEventListener("click", () => void loadRuns());
    void loadRuns();
    return;
  }
  void loadRuns();
}