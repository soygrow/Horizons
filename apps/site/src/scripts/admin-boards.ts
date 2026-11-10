/**
 * 后台「榜单版本」页签。
 *
 * 六个榜都发布到 D1 之后，这里是观察与回滚入口。灰度期站点仍读 JSON，
 * 所以本页的主要用途是**核对**：每期是否写全、某榜是否漏发、进出对不对。
 *
 * 三件必须说清楚的事：
 * - 版本是**全局快照**：`board_scope` 里有几个榜，这一期就有几个榜（其余是继承来的）。
 *   所以列表里要显示「本期包含」，而不是只显示本次发布的那个榜。
 * - 回滚只切指针，不重写数据。历史版本不可变，改了审计就失去意义。
 * - 切数据源是不可逆的线上行为，所以切 d1 前先问后端该榜有没有数据。
 */

import { $, apiGet, apiPost, esc, fmtNum, fmtTime } from "./admin-shared";

/* --------------------------------- 类型 --------------------------------- */

interface Release {
  version: string;
  scope: string[];
  stats: Record<string, number>;
  allowlistSize: number;
  actor: string | null;
  applied: boolean;
  createdAt: number;
  isCurrent: boolean;
}

interface ReleasesRes {
  current: string | null;
  keep: number;
  releases: Release[];
}

interface SourceRow {
  board: string;
  label: string;
  source: "file" | "d1";
}

interface SourcesRes {
  sources: SourceRow[];
}

interface Item {
  key: string;
  rank: number;
  score: number;
  tier: string;
  name: string;
  url: string | null;
  cats: string[];
}

interface ItemsRes {
  version: string;
  board: string;
  page: number;
  size: number;
  items: Item[];
}

interface Change {
  board: string;
  key: string;
  action: string;
  diff: unknown;
  actor: string | null;
}

interface ChangesRes {
  version: string;
  changes: Change[];
}

/* --------------------------------- 状态 --------------------------------- */

let mounted = false;
let currentVersion: string | null = null;
let currentBoard: string | null = null;
/** 版本号 → 本期包含的榜，点「查看」后用来生成榜按钮 */
let releasesByVersion = new Map<string, Release>();

/** 取值来自 publish-board 的 computeChanges：add / update / drop */
const ACTION_LABEL: Record<string, string> = {
  add: "新增",
  update: "变动",
  drop: "下榜",
};

const BTN_BASE =
  "rounded-lg border px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-60";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* --------------------------------- 入口 --------------------------------- */

export function mountAdminBoards(): void {
  if (mounted) return;
  mounted = true;

  $("boards-refresh-sources").addEventListener("click", () => void loadAll());
  $("boards-detail-close").addEventListener("click", () => {
    currentVersion = null;
    currentBoard = null;
    $("boards-detail").hidden = true;
  });

  void loadAll();
}

async function loadAll(): Promise<void> {
  await Promise.all([loadSources(), loadReleases()]);
}

/* -------------------------------- 数据源开关 -------------------------------- */

async function loadSources(): Promise<void> {
  const box = $("boards-sources");

  try {
    const res = await apiGet<SourcesRes>("/boards/sources");

    box.innerHTML = res.sources
      .map((s) => {
        const fileActive = s.source === "file";
        const d1Active = s.source === "d1";
        return `
          <div class="flex items-center justify-between gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2">
            <div class="min-w-0">
              <div class="truncate text-xs font-medium">${esc(s.label)}</div>
              <div class="text-[11px] text-ink-muted">${esc(s.board)} · 当前读 ${esc(s.source)}</div>
            </div>
            <div class="flex shrink-0 gap-1">
              <button type="button" data-source="${esc(s.board)}" data-value="file"
                class="${BTN_BASE} ${fileActive ? "border-primary text-primary" : "border-border text-ink-secondary hover:border-primary hover:text-primary"}">
                file
              </button>
              <button type="button" data-source="${esc(s.board)}" data-value="d1"
                class="${BTN_BASE} ${d1Active ? "border-primary text-primary" : "border-border text-ink-secondary hover:border-primary hover:text-primary"}">
                d1
              </button>
            </div>
          </div>`;
      })
      .join("");

    box.querySelectorAll<HTMLButtonElement>("button[data-source]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const board = btn.dataset.source ?? "";
        const value = btn.dataset.value === "d1" ? "d1" : "file";
        void switchSource(board, value);
      });
    });
  } catch (e) {
    box.innerHTML = `<p class="text-xs text-danger">读取数据源失败：${esc(msg(e))}</p>`;
  }
}

async function switchSource(board: string, source: "file" | "d1"): Promise<void> {
  if (
    !window.confirm(
      source === "d1"
        ? `把「${board}」切到数据库？\n\n切换后站点立刻读 D1，这个榜的线上内容会变成库里当前版本的数据。`
        : `把「${board}」切回 JSON？\n\n切换后站点读仓库文件，库里数据保留但不再被读取。`,
    )
  ) {
    return;
  }

  try {
    await apiPost("/boards/sources", { board, source });
    await loadSources();
  } catch (e) {
    window.alert(`切换失败：${msg(e)}`);
  }
}

/* --------------------------------- 版本列表 -------------------------------- */

async function loadReleases(): Promise<void> {
  const box = $("boards-releases");

  try {
    const res = await apiGet<ReleasesRes>("/boards/releases");

    $("boards-current").textContent = res.current ? `当前生效：${res.current}` : "尚未发布过";
    $("boards-keep").textContent = String(res.keep);
    releasesByVersion = new Map(res.releases.map((r) => [r.version, r]));

    if (res.releases.length === 0) {
      box.innerHTML =
        '<p class="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-ink-muted">还没有任何发布记录</p>';
      return;
    }

    box.innerHTML = res.releases
      .map((r) => {
        const scope = r.scope
          .map((b) => `${esc(b)} ${fmtNum(r.stats[b] ?? 0)}`)
          .join(" · ");

        return `
          <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-mono text-xs font-medium">${esc(r.version)}</span>
                ${r.isCurrent ? '<span class="rounded bg-primary/15 px-1.5 py-0.5 text-[11px] font-medium text-primary">当前</span>' : ""}
                ${r.applied ? "" : '<span class="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-500">草稿</span>'}
              </div>
              <div class="mt-1 text-[11px] text-ink-secondary">${scope || "（空）"}</div>
              <div class="mt-0.5 text-[11px] text-ink-muted">
                ${esc(r.actor ?? "—")} · ${esc(fmtTime(r.createdAt))}${r.allowlistSize > 0 ? ` · 白名单 ${r.allowlistSize}` : ""}
              </div>
            </div>
            <div class="flex shrink-0 gap-1.5">
              <button type="button" data-view="${esc(r.version)}"
                class="${BTN_BASE} border-border text-ink-secondary hover:border-primary hover:text-primary">
                查看
              </button>
              <button type="button" data-rollback="${esc(r.version)}" ${r.isCurrent ? "disabled" : ""}
                class="${BTN_BASE} border-border text-ink-secondary hover:border-danger hover:text-danger">
                回滚
              </button>
            </div>
          </div>`;
      })
      .join("");

    box.querySelectorAll<HTMLButtonElement>("button[data-view]").forEach((btn) => {
      btn.addEventListener("click", () => void openDetail(btn.dataset.view ?? ""));
    });

    box.querySelectorAll<HTMLButtonElement>("button[data-rollback]").forEach((btn) => {
      btn.addEventListener("click", () => void rollback(btn.dataset.rollback ?? ""));
    });
  } catch (e) {
    box.innerHTML = `<p class="text-xs text-danger">读取版本失败：${esc(msg(e))}</p>`;
  }
}

/* --------------------------------- 版本详情 -------------------------------- */

function openDetail(version: string): void {
  const release = releasesByVersion.get(version);
  if (!release) return;

  currentVersion = version;
  currentBoard = release.scope[0] ?? null;

  $("boards-detail").hidden = false;
  $("boards-detail-title").textContent = `版本 ${version}`;

  const tabs = $("boards-detail-tabs");
  if (release.scope.length === 0) {
    tabs.innerHTML = '<span class="text-xs text-ink-muted">这一期没有数据</span>';
    $("boards-detail-body").innerHTML = "";
    $("boards-detail-changes").innerHTML = "";
    return;
  }

  tabs.innerHTML = release.scope
    .map(
      (b) => `
      <button type="button" data-board="${esc(b)}"
        class="${BTN_BASE} ${b === currentBoard ? "border-primary text-primary" : "border-border text-ink-secondary hover:border-primary hover:text-primary"}">
        ${esc(b)} ${fmtNum(release.stats[b] ?? 0)}
      </button>`,
    )
    .join("");

  tabs.querySelectorAll<HTMLButtonElement>("button[data-board]").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentBoard = btn.dataset.board ?? null;
      tabs.querySelectorAll<HTMLButtonElement>("button[data-board]").forEach((b) => {
        const active = b.dataset.board === currentBoard;
        b.className = `${BTN_BASE} ${active ? "border-primary text-primary" : "border-border text-ink-secondary hover:border-primary hover:text-primary"}`;
      });
      void loadDetail();
    });
  });

  void loadDetail();
}

async function loadDetail(): Promise<void> {
  if (!currentVersion || !currentBoard) return;
  await Promise.all([loadItems(), loadChanges()]);
}

async function loadItems(): Promise<void> {
  const body = $("boards-detail-body");
  body.innerHTML = '<p class="text-xs text-ink-muted">加载中…</p>';

  try {
    const res = await apiGet<ItemsRes>(
      `/boards/releases/${encodeURIComponent(currentVersion!)}/items?board=${encodeURIComponent(currentBoard!)}&size=100`,
    );

    if (res.items.length === 0) {
      body.innerHTML = '<p class="text-xs text-ink-muted">这一期该榜没有条目</p>';
      return;
    }

    const rows = res.items
      .map(
        (it) => `
        <tr class="border-b border-border last:border-0">
          <td class="px-2 py-1.5 text-right tabular-nums text-ink-muted">${it.rank}</td>
          <td class="px-2 py-1.5">
            <div class="truncate font-medium">${esc(it.name)}</div>
            <div class="truncate text-[11px] text-ink-muted">${esc(it.key)}</div>
          </td>
          <td class="px-2 py-1.5 text-right tabular-nums">${it.score.toFixed(1)}</td>
          <td class="px-2 py-1.5 text-ink-secondary">${esc(it.tier)}</td>
          <td class="px-2 py-1.5 text-ink-secondary">${esc(it.cats.join(" / ") || "—")}</td>
        </tr>`,
      )
      .join("");

    body.innerHTML = `
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs">
          <thead class="text-[11px] text-ink-muted">
            <tr class="border-b border-border">
              <th class="px-2 py-1.5 text-right font-medium">名次</th>
              <th class="px-2 py-1.5 font-medium">条目</th>
              <th class="px-2 py-1.5 text-right font-medium">分数</th>
              <th class="px-2 py-1.5 font-medium">层级</th>
              <th class="px-2 py-1.5 font-medium">分类</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="mt-2 text-[11px] text-ink-muted">显示前 ${res.items.length} 条</p>`;
  } catch (e) {
    body.innerHTML = `<p class="text-xs text-danger">读取条目失败：${esc(msg(e))}</p>`;
  }
}

async function loadChanges(): Promise<void> {
  const box = $("boards-detail-changes");

  try {
    const res = await apiGet<ChangesRes>(
      `/boards/releases/${encodeURIComponent(currentVersion!)}/changes?board=${encodeURIComponent(currentBoard!)}`,
    );

    if (res.changes.length === 0) {
      box.innerHTML = "";
      return;
    }

    const list = res.changes
      .map(
        (ch) => `
        <li class="flex items-start gap-2 border-b border-border py-1.5 last:border-0">
          <span class="mt-0.5 shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-secondary">${esc(ACTION_LABEL[ch.action] ?? ch.action)}</span>
          <span class="min-w-0 flex-1 truncate font-mono text-[11px]">${esc(ch.key)}</span>
          <span class="shrink-0 text-[11px] text-ink-muted">${esc(summarizeDiff(ch.diff))}</span>
        </li>`,
      )
      .join("");

    box.innerHTML = `
      <h3 class="text-xs font-semibold">本期变更 <span class="font-normal text-ink-muted">（${res.changes.length} 条）</span></h3>
      <ul class="mt-1">${list}</ul>`;
  } catch (e) {
    box.innerHTML = `<p class="text-xs text-danger">读取变更失败：${esc(msg(e))}</p>`;
  }
}

/** diff 结构由发布脚本决定，这里只挑最常见的名次变化做摘要，其余给个标记 */
function summarizeDiff(diff: unknown): string {
  if (!diff || typeof diff !== "object") return "";
  const d = diff as Record<string, unknown>;
  const rank = d.rank as { from?: number; to?: number } | undefined;
  if (rank && typeof rank.from === "number" && typeof rank.to === "number") {
    return `${rank.from} → ${rank.to}`;
  }
  const keys = Object.keys(d);
  return keys.length > 0 ? keys.join(",") : "";
}

/* ----------------------------------- 回滚 ---------------------------------- */

async function rollback(version: string): Promise<void> {
  if (
    !window.confirm(
      `回滚到 ${version}？\n\n指针会立即切过去，读者看到的榜单会换成这一期。\n只切指针，不重写数据。`,
    )
  ) {
    return;
  }

  try {
    await apiPost("/boards/rollback", { version });
    window.alert(`已回滚到 ${version}`);
    await loadAll();
  } catch (e) {
    window.alert(`回滚失败：${msg(e)}`);
  }
}