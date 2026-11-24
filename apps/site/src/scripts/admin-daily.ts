/**
 * 后台「每日情报」页签。
 * 参照机会榜拆成两个子页签：
 *   - 线上情报：读 D1 的 digest_issues，点「看全文」展开这一期四个模块。
 *   - 情报生成：采集+成稿（compose）→ 看本期（读仓库成稿文件）→ 发布（publish）。
 * 采集/成稿/发布都在 GitHub Actions（daily.yml）跑，这里只触发与核对。
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

interface DigestItem {
  id: string;
  title: string;
  summary?: string;
  why?: string;
  category?: string;
  evidence?: string;
  heat?: number;
  missing?: string;
}

interface DigestModule {
  key: string;
  items: DigestItem[];
}

interface DigestFile {
  date: string;
  generatedAt?: string;
  stats?: { candidates: number; merged: number; verified: number; published: number };
  modules?: DigestModule[];
}

interface DraftRes {
  date: string;
  status: "published" | "draft" | "missing";
  draft: DigestFile | null;
  published: DigestFile | null;
}

interface RunStatusRes {
  status: string;
  run: { id: number; url: string; status: string; conclusion: string | null } | null;
}

/* --------------------------------- 常量 --------------------------------- */

const MODULE_ORDER = ["headline", "tools", "money", "action"] as const;
const MODULE_LABEL: Record<string, string> = { headline: "头条", tools: "能用", money: "钱", action: "能做" };
const STATUS_LABEL: Record<string, string> = { idle: "未运行", queued: "排队中", running: "运行中", success: "已完成", failed: "失败" };

let mounted = false;
let pollTimer: number | null = null;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function setStatus(id: string, text: string, tone: "idle" | "busy" | "ok" | "bad" = "idle"): void {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className =
    tone === "bad" ? "text-xs text-red-600"
    : tone === "ok" ? "text-xs text-emerald-600"
    : tone === "busy" ? "text-xs text-amber-600"
    : "text-xs text-ink-muted";
}

function getGenDate(): string {
  return (($("daily-date") as HTMLInputElement | null)?.value ?? "").trim();
}

/* -------------------------------- 渲染 --------------------------------- */

/** 一期四个模块的正文（线上详情与生成预览共用） */
function renderDigestBody(digest: DigestFile, badge: string, badgeClass: string): string {
  const modules = MODULE_ORDER.map((key) => {
    const items = (digest.modules ?? []).find((m) => m.key === key)?.items ?? [];
    const cards = items
      .map(
        (it) => `<li class="rounded-lg border border-border p-3">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="text-sm font-medium text-ink">${esc(it.title)}</div>
              ${it.summary ? `<p class="mt-1 text-xs leading-relaxed text-ink-secondary">${esc(it.summary)}</p>` : ""}
              ${it.why ? `<p class="mt-1 text-xs leading-relaxed text-ink-secondary"><span class="text-ink-muted">为什么重要：</span>${esc(it.why)}</p>` : ""}
            </div>
            <div class="shrink-0 text-right text-[11px] leading-relaxed text-ink-muted">
              ${it.category ? `<div>${esc(it.category)}</div>` : ""}
              ${it.heat != null ? `<div>热度 ${it.heat}/5</div>` : ""}
              ${it.evidence ? `<div>${esc(it.evidence)}</div>` : ""}
            </div>
          </div>
          ${it.missing ? `<p class="mt-1 text-[11px] text-amber-600">缺证据：${esc(it.missing)}</p>` : ""}
        </li>`,
      )
      .join("");

    return `<div>
      <div class="mb-2 flex items-baseline gap-2">
        <h4 class="text-xs font-semibold text-ink">${MODULE_LABEL[key] ?? key}</h4>
        <span class="text-[11px] text-ink-muted">${items.length} 条</span>
      </div>
      ${items.length ? `<ol class="space-y-2">${cards}</ol>` : `<p class="text-xs text-ink-muted">—</p>`}
    </div>`;
  }).join("");

  const stats = digest.stats
    ? `<p class="text-[11px] text-ink-muted">候选 ${digest.stats.candidates} · 合并 ${digest.stats.merged} · 核实 ${digest.stats.verified} · 发布 ${digest.stats.published}</p>`
    : "";

  return `<div class="space-y-4">
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-xs font-medium ${badgeClass}">${badge}</span>
      ${digest.generatedAt ? `<span class="text-[11px] text-ink-muted">成稿于 ${esc(fmtTime(digest.generatedAt))}</span>` : ""}
    </div>
    ${stats}
    ${modules}
  </div>`;
}

function renderIssues(issues: Issue[]): void {
  const body = $("daily-list");
  if (!body) return;

  if (!issues.length) {
    body.innerHTML = `<tr><td colspan="8" class="px-3 py-6 text-center text-xs text-ink-muted">还没有任何一期</td></tr>`;
    return;
  }

  body.innerHTML = issues
    .map((issue) => {
      const top = issue.top.length
        ? issue.top.map((t) => `<div class="truncate text-xs text-ink-secondary" title="${esc(t)}">${esc(t)}</div>`).join("")
        : `<span class="text-xs text-ink-muted">—</span>`;
      const cells = MODULE_ORDER.map((key) => {
        const n = issue.modules[key] ?? 0;
        return `<td class="px-2 py-1.5 text-center ${n === 0 ? "text-ink-muted" : "text-ink"}">${n}</td>`;
      }).join("");
      return `<tr class="border-t border-border">
        <td class="px-3 py-2 font-mono text-xs text-ink">${esc(issue.date)}</td>
        ${cells}
        <td class="px-3 py-1.5 text-center text-xs font-medium text-ink">${issue.total}</td>
        <td class="max-w-md px-3 py-2">${top}</td>
        <td class="px-3 py-2 text-right">
          <button type="button" data-issue-date="${esc(issue.date)}" class="rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-ink-secondary transition hover:border-border-strong hover:text-ink">看全文</button>
        </td>
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
    body.innerHTML = `<tr><td colspan="8" class="px-3 py-4 text-center text-xs text-red-600">读取失败：${esc(msg(e))}</td></tr>`;
  }
}

async function loadIssueDetail(date: string): Promise<void> {
  const box = $("daily-issue-detail");
  if (!box) return;
  box.hidden = false;
  box.innerHTML = `<div class="px-5 py-4 text-center text-xs text-ink-muted">读取中…</div>`;
  try {
    const digest = await apiGet<DigestFile>(`/daily/issues/${date}`);
    box.innerHTML = `<div class="px-5 py-4">${renderDigestBody(digest, "已发布", "text-emerald-600")}</div>`;
  } catch (e) {
    box.innerHTML = `<div class="px-5 py-4 text-center text-xs text-red-600">读取失败：${esc(msg(e))}</div>`;
  }
}

/* ------------------------------ 情报生成 -------------------------------- */

async function loadDraft(date: string): Promise<void> {
  const box = $("daily-preview");
  const publishBtn = $("daily-run-publish") as HTMLButtonElement | null;
  if (!box) return;

  const d = date.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    box.innerHTML = `<p class="text-xs text-ink-muted">期号须是 YYYY-MM-DD（留空=今天，先点「看本期」或直接「生成本期」）。</p>`;
    setStatus("daily-gen-status", "等待输入期号", "idle");
    if (publishBtn) publishBtn.disabled = true;
    return;
  }

  box.innerHTML = `<p class="text-xs text-ink-muted">读取中…</p>`;
  if (publishBtn) publishBtn.disabled = true;
  try {
    const res = await apiGet<DraftRes>(`/daily/draft/${d}`);
    const digest = res.published ?? res.draft;
    if (res.status === "published" && digest) {
      box.innerHTML = renderDigestBody(digest, "已发布", "text-emerald-600");
      setStatus("daily-gen-status", "这一期已发布，前台已可见。", "ok");
    } else if (res.status === "draft" && digest) {
      box.innerHTML = renderDigestBody(digest, "已成稿·未发布", "text-amber-600");
      setStatus("daily-gen-status", "已成稿、还没发布；点「发布本期」写进 D1。", "busy");
      if (publishBtn) publishBtn.disabled = false;
    } else {
      box.innerHTML = `<p class="text-xs text-ink-muted">这一期还没有成稿文件；点「生成本期」起采集+成稿任务。</p>`;
      setStatus("daily-gen-status", "还没成稿。", "idle");
    }
  } catch (e) {
    box.innerHTML = `<p class="text-xs text-red-600">读取失败：${esc(msg(e))}</p>`;
    setStatus("daily-gen-status", `预览失败：${msg(e)}`, "bad");
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
      el.innerHTML = `最近一次：${esc(label)}${link}`;
      el.className = tone === "bad" ? "text-xs text-red-600" : tone === "ok" ? "text-xs text-emerald-600" : tone === "busy" ? "text-xs text-amber-600" : "text-xs text-ink-muted";
    }
  } catch (e) {
    setStatus("daily-status", `状态读取失败：${msg(e)}`, "bad");
  }
}

function pollStatus(times = 8): void {
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  if (times <= 0) return;
  pollTimer = window.setTimeout(async () => {
    await refreshStatus();
    pollStatus(times - 1);
  }, 5000);
}

/* -------------------------------- 触发 --------------------------------- */

async function run(mode: "fetch" | "build" | "compose" | "publish" | "all", label: string): Promise<void> {
  const date = getGenDate();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    setStatus("daily-gen-status", "日期格式应为 YYYY-MM-DD，留空表示今天", "bad");
    return;
  }

  const ids = ["daily-run-fetch", "daily-run-build", "daily-run-compose", "daily-run-publish"] as const;
  for (const id of ids) {
    const btn = $(id) as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
  }

  setStatus("daily-gen-status", `正在触发「${label}」…`, "busy");
  try {
    await apiPost("/daily/run", { mode, date });
    setStatus("daily-gen-status", `${label}已提交，等待启动…`, "busy");
    pollStatus(8);
    window.setTimeout(() => void refreshStatus(), 5000);
    window.setTimeout(() => void loadDraft(date), 30_000);
    window.setTimeout(() => void loadIssues(), 90_000);
  } catch (e) {
    setStatus("daily-gen-status", `${label}触发失败：${msg(e)}`, "bad");
  } finally {
    for (const id of ids) {
      const btn = $(id) as HTMLButtonElement | null;
      if (btn) btn.disabled = false;
    }
    void loadDraft(date);
  }
}

/* -------------------------------- 挂载 --------------------------------- */

export function mountAdminDaily(): void {
  if (mounted) {
    void loadIssues();
    void refreshStatus();
    return;
  }
  mounted = true;

  // 默认今天（东八区）
  const input = $("daily-date") as HTMLInputElement | null;
  if (input) input.value = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

  // 子页签切换
  document.querySelectorAll<HTMLElement>("[data-daily-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.dailyView ?? "listed";
      document.querySelectorAll<HTMLElement>("[data-daily-view]").forEach((b) => (b.dataset.active = String(b === btn)));
      const listed = $("daily-view-listed");
      const generate = $("daily-view-generate");
      if (listed) listed.hidden = view !== "listed";
      if (generate) generate.hidden = view !== "generate";
      if (view === "generate") void loadDraft(getGenDate());
    });
  });

  const bind = (id: string, mode: "fetch" | "build" | "compose" | "publish" | "all", label: string): void => {
    $(id)?.addEventListener("click", () => void run(mode, label));
  };
  bind("daily-run-compose", "compose", "生成本期");
  bind("daily-run-publish", "publish", "发布本期");
  bind("daily-run-fetch", "fetch", "只采集");
  bind("daily-run-build", "build", "只成稿");

  $("daily-gen-reload")?.addEventListener("click", () => void loadDraft(getGenDate()));
  $("daily-refresh")?.addEventListener("click", () => {
    void loadIssues();
    void refreshStatus();
  });

  // 线上情报里点「看全文」
  $("daily-list")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-issue-date]");
    if (btn?.dataset.issueDate) void loadIssueDetail(btn.dataset.issueDate);
  });

  void refreshStatus();
  void loadIssues();
  void loadDraft(getGenDate());
}

export function refreshAdminDaily(): void {
  if (!mounted) return;
  void loadIssues();
  void refreshStatus();
}