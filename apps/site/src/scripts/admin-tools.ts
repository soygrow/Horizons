/**
 * 后台「工具榜」页签。
 *
 * 只做界面与交互：真正干活的是 API 里的 GitHub Actions 触发。
 *
 * 一条工具的生命周期（也是这张表的操作顺序）：
 *   候选 candidate →（确认收录）→ approved →（开始富化）→ enriching
 *   → enriched（可点名字看预览页）/ enrich_failed →（发布）→ 上线并移出队列
 *
 * 每一步都只对属于它的状态生效：富化只认 approved，发布只认 enriched，
 * 富化中的条目连复选框都不给勾。宁可少一个入口，也不让用户点出一笔冤枉钱。
 */

/* -------------------------------- 基础工具 -------------------------------- */

import { $, apiGet, apiPost, debounce, esc, fmtNum, fmtTime } from "./admin-shared";
import { mountToolsListed } from "./admin-tools-listed";

function fmtVisits(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toLocaleString("zh-CN");
}

/* --------------------------------- 类型 --------------------------------- */

interface Job {
  id: string;
  kind: "fetch" | "enrich" | "audit" | "publish";
  status: string;
  params: string;
  run_url: string | null;
  /** 失败原因，后端存的可能是错误码（dispatch_unconfirmed 等） */
  error?: string | null;
  created_at: number;
}

interface ToolStats {
  generatedAt: string;
  target: number;
  candidates: number;
  qualified: number;
  listed: number;
  core: number;
  watch: number;
  withTraffic: number;
  staging: { pending: number; approved: number; enriched: number; rejected: number };
  gap: number;
}

interface Overview {
  configured: boolean;
  missing: string[];
  stats: ToolStats | null;
  /** 数据库里的在榜条数，统计快照缺失时仍然有值 */
  board?: { total: number; updatedAt: string | null } | null;
  jobs: Job[];
  error?: string;
}

interface StagingRow {
  domain: string;
  name: string;
  url: string | null;
  description: string | null;
  phUpvotes: number;
  monthlyVisits: number | null;
  heatScore: number;
  categories: string[];
  firstSeenAt: string | null;
  tier: "core" | "watch" | "reject" | null;
  /** 采集时的判定理由，例如「A4 月访问 320 < 1,000」 */
  reason: string | null;
  /**
   * enriching / enrich_failed 是富化引入的中间态：占位中，以及失败后可重试。
   * publishing / publish_failed / published 是发布三态：已提交、失败可重发、已上线待清理。
   */
  stage:
    | "candidate"
    | "approved"
    | "enriching"
    | "enriched"
    | "enrich_failed"
    | "publishing"
    | "publish_failed"
    | "published";
  /** 富化后仍缺的页面维度（key 列表） */
  fieldGaps: string[];
  rejected: boolean;
}

interface StagingResp {
  updatedAt: string | null;
  lastRun: { at: string; requested: number; added: number; skipped: number; enriched: number } | null;
  total: number;
  pending: number;
  approved: number;
  /** 富化中的条数（被占住，不可重复选） */
  enriching?: number;
  /** 富化失败的条数（可重试） */
  enrichFailed?: number;
  enriched: number;
  /** 发布中（被占住，不可重复选） */
  publishing?: number;
  /** 发布失败（可重新选中再发） */
  publishFailed?: number;
  /** 已发榜（等人工点「处理完成」） */
  published?: number;
  rejected: number;
  /** 各筛选档的条数（已按搜索/来源收窄）：下拉只列有货的档位 */
  counts?: Record<string, number>;
  page: number;
  pageSize: number;
  items: StagingRow[];
}

/**
 * 待发布筛选下拉的档位 = 队列的 6 个状态，一个条目不落两档。
 *
 * 「富化中」「发布中」折进前一档：它们是同一件事的两个时刻，单列只会让人
 * 在两处找同一条目。达标/不达标是判定维度、已拒绝是拒绝名单，都不是队列状态，不放进这里。
 *
 * 只列当前队列里真的有货的档位（计数由后端按同一口径算）—— 没有发布失败时
 * 还挂着「发布失败」，点开就是一张空表，只能让人以为后台坏了。
 */
const TIER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "all", label: "全部" },
  { value: "pending", label: "待确认" },
  { value: "approved", label: "待富化（含富化中）" },
  { value: "enrich_failed", label: "富化失败" },
  { value: "enriched", label: "待发布（含发布中）" },
  { value: "publish_failed", label: "发布失败" },
  { value: "published", label: "发布完成" },
];

interface AuditDropped {
  domain: string;
  name: string;
  reason: string;
  monthlyVisits?: number;
}

interface PreviewResp {
  pending: number;
  approved: number;
  enriched: number;
  /** 上次发布失败、这次会一起重发的条数 */
  publishFailed?: number;
  candidates: number;
  rejected: number;
  estimate: { candidatesAfter: number; listedBefore: number; listedAfter?: number; dropCount?: number } | null;
  /** null = 还没跑过存量重判，下榜清单未知 */
  audit: {
    generatedAt: string | null;
    total: number;
    dropCount: number;
    dropped: AuditDropped[];
    degraded: Array<{ domain: string; name: string; monthlyVisits?: number }>;
    refreshedTraffic: boolean;
    probed: boolean;
  } | null;
}

interface FieldIssue {
  key: string;
  label: string;
  reason: string;
}

interface FieldReport {
  generatedAt: string;
  total: number;
  itemsWithIssues?: number;
  dimensions: Array<{
    key: string;
    label: string;
    /** 空置：没采到 */
    missing: number;
    missingRatio: number;
    missingDomains?: string[];
    /** 异常：有值但不合法 */
    invalid?: number;
    invalidRatio?: number;
    invalidSamples?: Array<{ domain: string; reason: string }>;
  }>;
  entryIssues?: Array<{ domain: string; label: string; reason: string }>;
  items: Array<{
    domain: string;
    name: string;
    gapCount: number;
    gaps: string[];
    issueCount?: number;
    issues?: FieldIssue[];
  }>;
}

/* --------------------------------- 状态 --------------------------------- */

const state = {
  page: 1,
  q: "",
  tier: "all",
  staging: null as StagingResp | null,
  /** 最近一次发布预览：勾选一变就要据此重算按钮数字，不能等接口回来 */
  preview: null as PreviewResp | null,
  stats: null as ToolStats | null,
  detailDomain: "",
  detailRejected: false,
  /** 批量操作选中的域名 */
  selected: new Set<string>(),
  polling: 0 as number | undefined,
  /** 上一轮是否有富化任务在跑：用于「刚跑完」时补一次队列刷新 */
  enrichBusy: false,
  /** 最近一次拿到的任务列表：勾选变化时要据此重算富化按钮，不能等下次轮询 */
  jobs: [] as Job[],
  /**
   * 刚提交、D1 状态还没变成 enriching 的域名（提交时间戳）。
   * markEnriching 在 dispatch 之后才执行，这段空窗里如果不本地占位，
   * 按钮会因为「还是待富化」再次亮起，点一下就重复扣一遍钱。
   */
  enrichPending: new Map<string, number>(),
  mounted: false,
};

/* -------------------------------- 渲染 ---------------------------------- */

/**
 * 未终结的任务。
 *
 * 不能只写 `queued || running`：GitHub 在 run 创建初期会返回 pending，
 * 后端旧版本会把它原样落库，于是库里就有 pending 这种第四种状态 ——
 * 按 queued/running 判活跃的话，它既不会触发 12 秒轮询、也不会排到列表最前，
 * 但 statusBadge 的 default 又把它渲染成「排队中」，看起来就是「永远排队」。
 */
const LIVE_JOB_STATUS = new Set(["queued", "running", "requested", "waiting", "pending", "in_progress"]);
const isLiveJob = (status: string): boolean => LIVE_JOB_STATUS.has(status);

function statusBadge(status: string): { label: string; cls: string } {
  switch (status) {
    case "success":
      return { label: "成功", cls: "bg-accent-soft text-accent" };
    case "running":
      return { label: "运行中", cls: "bg-primary-soft text-primary" };
    case "failure":
      return { label: "失败", cls: "bg-danger-soft text-danger" };
    case "cancelled":
      return { label: "已取消", cls: "bg-surface-2 text-ink-muted" };
    default:
      return { label: "排队中", cls: "bg-surface-2 text-ink-muted" };
  }
}

function tierBadge(tier: "core" | "watch" | "reject" | null): string {
  if (tier === "core") {
    return `<span class="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary">主榜</span>`;
  }
  if (tier === "watch") {
    return `<span class="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">观察</span>`;
  }
  if (tier === "reject") {
    return `<span class="rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger">不收录</span>`;
  }
  return `<span class="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-ink-muted">未判定</span>`;
}

function stageBadge(stage: StagingRow["stage"]): string {
  switch (stage) {
    case "approved":
      return `<span class="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary">待富化</span>`;
    case "enriching":
      return `<span class="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary animate-pulse" title="富化任务已提交，跑完自动更新">富化中</span>`;
    case "enriched":
      return `<span class="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">可发榜</span>`;
    case "enrich_failed":
      return `<span class="rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger" title="富化失败，勾选后可以重试（会再次计费）">富化失败</span>`;
    case "publishing":
      return `<span class="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary animate-pulse" title="发布任务已提交，跑完自动更新">发布中</span>`;
    case "publish_failed":
      return `<span class="rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger" title="发布失败，勾选后可以重新发布">发布失败</span>`;
    case "published":
      return `<span class="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent" title="已上线。确认没问题后点「处理完成」，这条才会从后台消失">发布成功</span>`;
    default:
      return `<span class="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-muted">待确认</span>`;
  }
}

/**
 * 解析「指定网站」输入框。
 *
 * 与后端 normalizeDomainInput 同一套规则，但只用来算条数和切换禁用态；
 * 真正的注册域归一在 fetch-staging 的 tldts 里做，不在这里重复实现一份。
 */
function parseDomainsInput(): string[] {
  const raw = ($("tools-fetch-domains") as HTMLTextAreaElement).value;
  const out: string[] = [];
  for (const piece of raw.split(/[\s,，、;；]+/)) {
    const s = piece
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/[/?#].*$/, "");
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(s)) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/* ---------------------- Topic 检索（PH 的 slug 下拉） ---------------------- */

interface PhTopic {
  slug: string;
  name: string;
  followers: number;
  posts: number;
}

/** PH 全站 400 多个 topic，一次拉完本地过滤：约 30KB，浏览器缓存住，不碰 token 也不吃配额 */
let phTopics: PhTopic[] | null = null;
let phTopicsLoading: Promise<PhTopic[]> | null = null;

function loadPhTopics(): Promise<PhTopic[]> {
  if (phTopics) return Promise.resolve(phTopics);
  if (!phTopicsLoading) {
    phTopicsLoading = fetch("/ph-topics.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { topics?: PhTopic[] }) => (phTopics = d.topics ?? []))
      .catch(() => {
        // 清单拿不到不能把输入框卡死：清掉缓存下次聚焦再试，手填 slug 照旧可用
        phTopicsLoading = null;
        return [] as PhTopic[];
      });
  }
  return phTopicsLoading;
}

/**
 * 本地检索。
 *
 * 不用 PH 自己的 topics(query:)：它是纯子串匹配且不排序 —— 搜 ai 会返回
 * Fundraising（fundr**ai**sing）、Pitch Dubai（dub**ai**），搜 agent 直接 0 条。
 * 放本地才能做「前缀优先 + 热度排序」，也才不会把不存在的词伪装成查询失败。
 */
function searchPhTopics(all: PhTopic[], q: string): PhTopic[] {
  const k = q.trim().toLowerCase();
  if (!k) return all.slice(0, 12);
  const scored = all
    .filter((t) => t.slug.includes(k) || t.name.toLowerCase().includes(k))
    .map((t) => ({
      t,
      prefix: t.slug.startsWith(k) || t.name.toLowerCase().startsWith(k) ? 1 : 0,
    }));
  scored.sort((a, b) => b.prefix - a.prefix || b.t.followers - a.t.followers);
  return scored.slice(0, 40).map((s) => s.t);
}

/** Topic 输入框的检索下拉：聚焦列出热门，输入即过滤，↑↓ + 回车选中，Esc 收起 */
function mountTopicPicker(): void {
  const input = $<HTMLInputElement>("tools-fetch-topic");
  const menu = $<HTMLUListElement>("tools-fetch-topic-menu");
  if (!input || !menu) return;

  let rows: PhTopic[] = [];
  let active = -1;

  const close = (): void => {
    menu.classList.add("hidden");
    input.setAttribute("aria-expanded", "false");
    active = -1;
  };

  const paint = async (): Promise<void> => {
    if (input.disabled) return close();
    const all = await loadPhTopics();
    const typed = input.value.trim();
    rows = searchPhTopics(all, typed);
    active = -1;

    const items = rows.map(
      (t, i) =>
        `<li role="option" data-i="${i}" class="flex cursor-pointer items-baseline justify-between gap-2 px-2.5 py-1.5 text-xs hover:bg-surface-2">` +
        `<span class="truncate"><span class="font-mono">${esc(t.slug)}</span>` +
        `<span class="ml-1.5 font-normal text-ink-muted">${esc(t.name)}</span></span>` +
        `<span class="shrink-0 font-normal text-[11px] text-ink-muted">${fmtNum(t.followers)} 粉 · ${fmtNum(t.posts)} 帖</span></li>`,
    );
    if (!items.length) {
      items.push(
        `<li class="px-2.5 py-1.5 text-[11px] font-normal text-ink-muted">没有匹配的 topic</li>`,
      );
    }
    // 手填 / 拼错的 slug：先把「会静默回退」说出来，别等跑完对着「翻 0 页」猜是不是被封
    if (typed && !all.some((t) => t.slug === typed)) {
      items.push(
        `<li class="border-t border-border px-2.5 py-1.5 text-[11px] font-normal text-warning">` +
          `「${esc(typed)}」不是 PH 的 topic，抓取时会回退 artificial-intelligence</li>`,
      );
    }
    menu.innerHTML = items.join("");
    menu.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
  };

  input.addEventListener("focus", () => void paint());
  input.addEventListener("input", debounce(() => void paint(), 120));
  input.addEventListener("blur", () => window.setTimeout(close, 120));

  input.addEventListener("keydown", (e) => {
    if (menu.classList.contains("hidden")) return;
    const lis = [...menu.querySelectorAll<HTMLLIElement>("li[data-i]")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!lis.length) return;
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + lis.length) % lis.length;
      lis.forEach((li, i) => li.classList.toggle("bg-surface-2", i === active));
      lis[active]?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (e.key === "Enter" && active >= 0 && rows[active]) {
      e.preventDefault();
      input.value = rows[active].slug;
      close();
      return;
    }
    if (e.key === "Escape") close();
  });

  // 用 mousedown 而不是 click：blur 先触发会把菜单收掉，点击就永远落空
  menu.addEventListener("mousedown", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>("li[data-i]");
    if (!li) return;
    e.preventDefault();
    const picked = rows[Number(li.dataset.i)];
    if (picked) input.value = picked.slug;
    close();
  });
}

/** 抓取表单底部的预估文案：候选池变化 + Apify 流量成本 */
function updateFetchEstimate(): void {
  const domains = parseDomainsInput();
  const manual = domains.length > 0;
  // 指定网站模式下数量/排序/topic 都不参与：禁用而不是清零，
  // 这样清空输入框就能立刻回到原来的选择
  for (const id of ["tools-fetch-count", "tools-fetch-order", "tools-fetch-topic"]) {
    const el = $(id) as HTMLInputElement | HTMLSelectElement;
    el.disabled = manual;
    el.classList.toggle("opacity-50", manual);
  }

  const count = manual ? domains.length : Number(($("tools-fetch-count") as HTMLSelectElement).value) || 60;
  const enrich = ($("tools-fetch-enrich") as HTMLInputElement).checked;
  const before = state.stats?.candidates;
  const pool = manual
    ? `指定 ${domains.length} 个站点（忽略数量/排序/topic，已在榜单或已审过的自动跳过）`
    : before == null
      ? `新增约 ${fmtNum(count)} 条候选`
      : `候选池 ${fmtNum(before)} → 约 ${fmtNum(before + count)} 条（去重前）`;
  // 准入采集按 vortex base_data 实价 $0.002/条估；命中 collect_raw 的不计费，
  // 所以这是上限而不是均价（日志里「本次花费」才是真实账单）。
  const cost = enrich
    ? `准入采集上限约 $${(count * 0.002).toFixed(2)}（$0.002/条，命中缓存不计费）`
    : "不补流量：只有 PH 点赞 ≥ 300 的能进榜";
  $("tools-fetch-estimate").textContent = [pool, cost, "跑完先落在「待发布」，不影响线上"].join("｜");
}

function renderOverview(data: Overview): void {
  $("tools-setup").classList.toggle("hidden", data.configured);

  if (!data.configured) {
    $("tools-setup-missing").textContent = `缺少：${data.missing.join("、")}`;
    for (const id of ["tool-kpi-listed", "tool-kpi-candidates", "tool-kpi-pending", "tool-kpi-gap"]) {
      $(id).textContent = "—";
    }
    $("tools-fetch-btn").setAttribute("disabled", "true");
    $("tools-publish-btn").setAttribute("disabled", "true");
    return;
  }

  $("tools-fetch-btn").removeAttribute("disabled");
  const s = data.stats;
  state.stats = s;
  updateFetchEstimate();
  if (!s) {
    // 统计快照缺失不代表榜单为空：正式榜还在线上跑，用库里的条数兜底
    $("tool-kpi-listed").textContent = data.board ? fmtNum(data.board.total) : "—";
    $("tool-kpi-listed-sub").textContent = data.board
      ? `正式榜 ${fmtNum(data.board.total)} 条${data.board.updatedAt ? ` · ${fmtTime(data.board.updatedAt)}` : ""}`
      : "还没有快照，抓取或发布一次后生成";
    return;
  }

  /*
   * 榜单条数以 D1 发布写入的 board 为准 —— 它和首页 hydrate 出来的
   * content/aitools.json 是同一份数据，两边必然一致。
   * stats.listed 只是统计快照，可能滞后或缺失，仅在 board 缺位时兜底。
   */
  const listedTotal = data.board?.total || s.listed;
  $("tool-kpi-listed").textContent = `${fmtNum(listedTotal)} / ${fmtNum(s.target)}`;
  $("tool-kpi-listed-sub").textContent = `主榜 ${fmtNum(s.core)} · 观察区 ${fmtNum(s.watch)}`;
  $("tool-kpi-candidates").textContent = fmtNum(s.candidates);
  $("tool-kpi-candidates-sub").textContent = `在榜 ${fmtNum(s.qualified)} · 有流量 ${fmtNum(s.withTraffic)}`;
  $("tool-kpi-pending").textContent = fmtNum(s.staging.pending);
  $("tool-kpi-pending-sub").textContent = `已拒绝 ${fmtNum(s.staging.rejected)}`;
  $("tool-kpi-gap").textContent = fmtNum(Math.max(0, s.target - listedTotal));

  const ratio = s.target > 0 ? Math.round((listedTotal / s.target) * 100) : 0;
  $("tool-kpi-gap-sub").textContent = `达标率 ${ratio}% · 快照 ${fmtTime(s.generatedAt)}`;
}

function kindLabelOf(kind: string): string {
  switch (kind) {
    case "fetch":
      return "抓取";
    case "enrich":
      return "富化";
    case "audit":
      return "重判";
    case "publish":
      return "发布";
    case "refresh":
      // 线上榜单的「更新数据」也是走采集链路，混排在同一块里得让人认出来
      return "更新";
    default:
      return kind;
  }
}

/**
 * 任务列表只展示最近几次：历史累积会把这一块撑得很长，日志本来就能去 Actions 翻。
 *
 * 这块常驻在两个页签上方，行数直接决定首屏高度，所以宁少勿多。
 * 4 行是为了让「抓取」和「更新」同时跑时都能露出来，不用滚动。
 */
const JOB_ROWS_VISIBLE = 4;

function pickRecentJobs(jobs: Job[]): { rows: Job[]; hidden: number } {
  const isActive = (j: Job) => isLiveJob(j.status);
  const active = jobs.filter(isActive);
  const finished = jobs.filter((j) => !isActive(j));
  // 固定 JOB_ROWS_VISIBLE 行：运行中的优先占前几位，但不再因为它「有几个」而放宽行数。
  // 之前是 Math.max(JOB_ROWS_VISIBLE, active.length)，队列里一旦有 queued 僵尸，
  // 行数就会跟着涨、刷新后又缩回去 —— 行数必须只由常量决定。
  const rows = [...active, ...finished].slice(0, JOB_ROWS_VISIBLE);
  return { rows, hidden: jobs.length - rows.length };
}

/**
 * 富化单价（单条），对齐 scripts/field-collect/index.ts 里的 PRICE 实价：
 *   vortex aitdk 模式   $0.002（注册日 / 关键词密度）
 *   Google SERP         $0.0025/query，每次 2–3 条（关键词排名 2 + 发布日 1）
 *   LLM 字段抽取        $0.001
 *   vortex base_data    不重复收费：富化直接读准入阶段存下的 collect_raw
 *   备选源 lergassy     $0.004，只在流量组仍不足时才买
 *
 * DFS 早已下线，不再有「$0.18 一条」那一档；按实际调用报账，别用废口径吓人。
 */
const ENRICH_COST = {
  /** 单条基准：aitdk $0.002 + 3 条 SERP $0.0075 + LLM $0.001 ≈ $0.0105 */
  perSite: 0.002 + 3 * 0.0025 + 0.001,
  /** 流量组缺失时追加的备选源单价 */
  fallback: 0.004,
} as const;

/**
 * 流量维度缺失 → 富化会额外买一次 lergassy 备选源。
 *
 * 注意 fieldGaps 的 key 是 FIELD_DIMENSIONS 的字段路径（如 trafficMetrics.monthlyVisits），
 * 不是「searchTraffic.organic」这类旧 DFS 维度名 —— 用前缀判断才能命中。
 */
function lacksTraffic(r: StagingRow): boolean {
  return r.fieldGaps.some(
    (k) => k.startsWith("trafficMetrics.") || k === "metrics.monthlyVisits",
  );
}

function estimateEnrich(
  rows: StagingRow[],
  countFallback?: number,
): { count: number; perSite: number; fallback: number; total: number; rough: boolean } {
  const count = countFallback ?? rows.length;
  // 队列只展示当前页时，看不见的条目按「还要多买一份备选源」估上限，宁可报多不报少
  const unseen = Math.max(0, count - rows.length);
  const fallback = rows.filter(lacksTraffic).length + unseen;
  const total = count * ENRICH_COST.perSite + fallback * ENRICH_COST.fallback;
  return { count, perSite: ENRICH_COST.perSite, fallback, total, rough: unseen > 0 };
}

/** 富化只认这两种状态：后端 markEnriching 与脚本 --domains 是同一口径 */
function enrichRunnable(stage: StagingRow["stage"]): boolean {
  return stage === "approved" || stage === "enrich_failed";
}

/** 刚提交、库里还没标成 enriching 的条目，本地先当成富化中 */
function isEnrichPending(domain: string): boolean {
  const at = state.enrichPending.get(domain);
  if (at == null) return false;
  // 90 秒足够 dispatch + markEnriching 落地；超时作废，
  // 免得状态因为异常一直刷不回来时把条目永久锁在本地
  if (Date.now() - at < 90_000) return true;
  state.enrichPending.delete(domain);
  return false;
}

/** 这一条现在能不能送去富化：状态可跑 + 不是刚提交的那批 */
function canEnrich(row: StagingRow): boolean {
  return enrichRunnable(row.stage) && !isEnrichPending(row.domain);
}

/**
 * 富化按钮能不能点，只看「这一批里有没有可富化的条目」。
 *
 * 以前是「有任务在跑就全局锁死」：可一个批次要跑十几分钟，期间队列里
 * 其它待富化的条目全被挡在外面。而富化中的条目本来就已经被 markEnriching
 * 占住了（复选框禁用、后端也不会重复标记），没必要让整张表跟着停。
 *
 * 唯一还要拦的是「有任务在跑 + 没勾选」：不勾等于跑全部已确认，
 * 必然和正在跑的批次重叠，脚本在缺省 --domains 时还会把 enriching 的一起挑走。
 */
function syncEnrichButton(jobs: Job[]): void {
  const btn = $("tools-enrich-btn") as HTMLButtonElement;
  const running = jobs.find(
    (j) => j.kind === "enrich" && isLiveJob(j.status),
  );

  // 刚跑完：条目状态是脚本最后一步才写库的，最后一次轮询未必赶上，
  // 这里补一次刷新，让「富化中 → 成功/失败」自己变过去
  const busy = !!running;
  if (state.enrichBusy && !busy) {
    window.setTimeout(() => {
      void loadStaging();
      void loadPreview();
    }, 3000);
  }
  state.enrichBusy = busy;

  const rows = state.staging?.items ?? [];
  const picked = rows.filter((r) => state.selected.has(r.domain));
  // 勾了就按勾的算；没勾 = 整个队列的已确认数（当前页可能只显示一部分）
  const runnable = picked.length
    ? picked.filter(canEnrich).length
    : Math.max(
        // 未勾选 = 跑队列里全部可富化的（待富化 + 富化失败，失败重试也是合法可跑）：
        // 扣掉刚提交、库里还没标上的那几条
        (state.staging?.approved ?? 0) +
          (state.staging?.enrichFailed ?? 0) -
          [...state.enrichPending.keys()].filter(isEnrichPending).length,
        rows.filter(canEnrich).length,
      );

  const needPick = busy && picked.length === 0;
  btn.disabled = runnable === 0 || needPick;
  // 有任务在跑时还能点，说明是「再追加一批」：文案要说清不是重复下单
  btn.textContent = busy ? "继续富化" : "开始富化";
  btn.title = needPick
    ? "已有富化任务在跑：勾选要富化的条目再提交，正在跑的那批不会被重复提交"
    : runnable === 0
      ? picked.length
        ? "勾选的条目都已富化或正在富化，没有可富化的"
        : "没有待富化的条目：先在「待确认」里确认收录"
      : "";
}

/** 任务失败原因悬停提示：后端存的是错误码，翻成人话 */
function jobErrorHint(job: Job): string {
  const e = job.error ?? "";
  if (e.startsWith("dispatch_unconfirmed")) {
    return "GitHub 已收到请求但没创建运行，本次没有真正启动，可以直接重试";
  }
  return e || "没有关联的运行记录";
}

/** 卡片头的「最近 N 次」：带上运行中数量，一眼知道要不要等它跑完 */
function syncJobsMeta(jobs: Job[]): void {
  const el = $("tools-jobs-meta");
  if (!el) return;
  const active = jobs.filter((j) => isLiveJob(j.status)).length;
  el.textContent = active
    ? `最近 ${JOB_ROWS_VISIBLE} 次 · 运行中 ${active}`
    : `最近 ${JOB_ROWS_VISIBLE} 次`;
}

function renderJobs(jobs: Job[]): void {
  const box = $("tools-jobs");
  const prevStatus = new Map(state.jobs.map((j) => [j.id, j.status]));
  state.jobs = jobs;
  syncEnrichButton(jobs);
  syncJobsMeta(jobs);
  if (!jobs.length) {
    box.innerHTML = `<p class="px-4 py-4 text-xs text-ink-muted">还没有任务。在下方点「开始抓取」或「更新数据」，进度会显示在这里。</p>`;
    return;
  }

  // 轮询看全量，别因为被截断就停了
  schedulePolling(jobs.some((j) => isLiveJob(j.status)));

  /*
   * 任务刚结束：条目的最终状态是后端最后一刻才落库的（发布成功由流水线写 published，
   * 失败由 /jobs 退回 publish_failed），这一轮并发拉到的 staging 可能还是旧值。
   * 稍等一拍再拉一次，界面才能立刻从「发布中」翻成「发布成功 / 发布失败」。
   */
  const justSettled = jobs.some(
    (j) =>
      (j.status === "success" || j.status === "failure" || j.status === "cancelled") &&
      isLiveJob(prevStatus.get(j.id) ?? ""),
  );
  if (justSettled) {
    window.setTimeout(() => {
      void loadStaging();
      void loadOverview();
    }, 1200);
  }

  const { rows, hidden } = pickRecentJobs(jobs);

  box.innerHTML = rows
    .map((job) => {
      const badge = statusBadge(job.status);
      const params = (() => {
        try {
          const p = JSON.parse(job.params) as Record<string, unknown>;
          if (job.kind === "fetch") {
            if (Array.isArray(p.domains) && p.domains.length) {
              return `指定 ${p.domains.length} 个站点${p.enrich ? " · 补流量" : ""}`;
            }
            const order = p.order === "votes" ? "按点赞" : "最新";
            return `${p.count ?? "?"} 个 · ${order}${p.enrich ? " · 补流量" : ""}`;
          }
          if (job.kind === "enrich") {
            const n = Array.isArray(p.domains) ? p.domains.length : Number(p.limit ?? 0);
            return n ? `富化 ${n} 条` : "富化已确认条目";
          }
          if (job.kind === "audit") {
            return `${p.traffic ? "刷新流量" : "不刷流量"} · ${p.probe ? "探活" : "不探活"}`;
          }
          return typeof p.note === "string" && p.note ? p.note : "合并待发布 → 榜单";
        } catch {
          return kindLabelOf(job.kind);
        }
      })();
      // 没有 run_url 的多半是派发没被确认：破折号上挂个悬停说明，别让人以为只是没日志
      const link = job.run_url
        ? `<a href="${esc(job.run_url)}" target="_blank" rel="noopener" class="text-primary hover:underline">日志</a>`
        : `<span class="cursor-help" title="${esc(jobErrorHint(job))}">—</span>`;
      return `<div class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5 text-xs last:border-b-0">
          <span class="w-14 shrink-0 text-ink-muted">${kindLabelOf(job.kind)}</span>
          <span class="min-w-0 flex-1 truncate text-ink-secondary">${esc(params)}</span>
          <span class="shrink-0 rounded-full px-2 py-0.5 font-semibold ${badge.cls}">${badge.label}</span>
          <span class="w-24 shrink-0 text-right text-ink-muted">${fmtTime(job.created_at)}</span>
          <span class="w-10 shrink-0 text-right">${link}</span>
        </div>`;
    })
    .join("");

  if (hidden > 0) {
    box.insertAdjacentHTML(
      "beforeend",
      `<p class="px-4 py-2 text-[11px] text-ink-muted">仅显示最近 ${rows.length} 次，另有 ${hidden} 条更早记录</p>`,
    );
  }
}

/**
 * 「批量处理完成」按钮：只统计「已发布成功」的条目，队列里没有就置灰。
 *
 * 数量取队列统计而不是当前页 —— 分页时后面几页的发榜条目也要能被一次收尾。
 */
function syncDoneButton(data: StagingResp): void {
  const btn = $("tools-done-btn") as HTMLButtonElement | null;
  if (!btn) return;
  const n = data.published ?? 0;
  btn.disabled = n === 0;
  btn.textContent = n > 0 ? `批量处理完成（${n}）` : "批量处理完成";
  btn.title =
    n > 0
      ? `把 ${n} 条「已发布成功」的条目批量移出后台队列，线上榜单不受影响`
      : "没有「已发布成功」的条目需要收尾";
}

/**
 * 按当前队列重算下拉档位：没货的档位不显示，有货的带上条数。
 *
 * 当前选中的档位即使变成 0 也留着 —— 否则用户正看着「仅富化失败」时
 * 下拉会自己跳回「全部」，列表跟着变，像被后台抢了操作。
 */
let tierOptionsSig = "";

function syncTierOptions(data: StagingResp): void {
  const sel = $("tools-staging-tier") as HTMLSelectElement | null;
  if (!sel || !data.counts) return;
  const counts = data.counts;
  const options = TIER_OPTIONS.filter(
    (o) => o.value === "all" || (counts[o.value] ?? 0) > 0 || o.value === state.tier,
  );
  // 12 秒一轮询，档位没变就别重建 DOM：下拉正展开时重建会把用户踢出选择状态
  const sig = options.map((o) => `${o.value}:${counts[o.value] ?? 0}`).join("|");
  if (sig !== tierOptionsSig) {
    tierOptionsSig = sig;
    sel.innerHTML = options
      .map((o) => `<option value="${o.value}">${o.label}（${counts[o.value] ?? 0}）</option>`)
      .join("");
  }
  sel.value = options.some((o) => o.value === state.tier) ? state.tier : "all";
  state.tier = sel.value;
}

function renderStaging(data: StagingResp): void {
  state.staging = data;
  syncTierOptions(data);

  const meta = $("tools-staging-meta");
  if (!data.pending) {
    meta.textContent = "队列为空。抓取一次后，新工具会先进到这里等你审核。";
  } else {
    const last = data.lastRun
      ? `｜上次 +${data.lastRun.added}${fmtTime(data.lastRun.at)}`
      : "";
    // 富化中/失败单独列：混进「已确认」会让人以为还能再提交一次
    const busy = data.enriching ? ` · 富化中 ${data.enriching}` : "";
    const bad = data.enrichFailed ? ` · 富化失败 ${data.enrichFailed}` : "";
    meta.textContent =
      `待确认 ${data.pending} · 已确认 ${data.approved}${busy}${bad} · 可发榜 ${data.enriched} · 已拒绝 ${data.rejected}` +
      `｜筛选后 ${data.total} 个${last}`;
  }

  // 选中项只保留当前列表里还存在的，避免删改后残留
  const visible = new Set(data.items.map((r) => r.domain));
  for (const d of state.selected) if (!visible.has(d)) state.selected.delete(d);
  // 本地占位到期的回收：库里状态已经不是「待富化/富化失败」就不用再挡它
  for (const d of [...state.enrichPending.keys()]) {
    const row = data.items.find((r) => r.domain === d);
    if (row && !enrichRunnable(row.stage)) state.enrichPending.delete(d);
  }
  // 富化中的行不可选，全选状态只能按「可选行」算，否则永远显示未全选
  const selectable = data.items.filter((r) => r.stage !== "enriching");
  const all = $("tools-select-all") as HTMLInputElement | null;
  if (all) {
    all.checked = selectable.length > 0 && selectable.every((r) => state.selected.has(r.domain));
    all.disabled = selectable.length === 0;
  }

  const body = $("tools-staging-body");
  if (!data.items.length) {
    body.innerHTML = `<tr><td colspan="9" class="px-4 py-10 text-center text-xs text-ink-muted">没有符合条件的条目</td></tr>`;
  } else {
    body.innerHTML = data.items
      .map((row) => {
        // 富化中/发布中的条目已被任务占住（再选就是重复付费或重复发布），
        // 已发榜的等人工点「处理完成」收尾 —— 这三种都不参与勾选
        const locked =
          row.stage === "enriching" || row.stage === "publishing" || row.stage === "published";
        const checked = state.selected.has(row.domain) && !locked ? " checked" : "";
        const lockTitle =
          row.stage === "enriching"
            ? "富化进行中，不能重复选择"
            : row.stage === "publishing"
              ? "发布进行中，不能重复选择"
              : "已发布成功，点「处理完成」后才会移出列表";
        const reason = row.rejected ? "已拒绝：不再抓取" : (row.reason ?? "—");
        // 富化过的（含发布三态）都能看到缺失字段，方便回查当初富化得怎么样
        const enrichedStage =
          row.stage === "enriched" ||
          row.stage === "enrich_failed" ||
          row.stage === "publishing" ||
          row.stage === "publish_failed" ||
          row.stage === "published";
        const missing = enrichedStage
          ? row.fieldGaps.length
            ? `${row.fieldGaps.length} 项`
            : "完整"
          : row.stage === "enriching"
            ? "富化中"
            : "—";
        // 富化过的条目才有预览页（构建期从 D1 导出）；没富化的打开抽屉就够了
        const previewable = enrichedStage || row.stage === "enriching";
        const nameCell = previewable
          ? `<a href="/preview/${esc(row.domain)}" target="_blank" rel="noopener" class="block max-w-full truncate font-medium text-primary hover:underline" title="在新窗口预览详情页（与线上同一套布局，需管理员登录）">${esc(row.name)}</a>`
          : `<button type="button" data-tool-open="${esc(row.domain)}" class="block max-w-full truncate text-left font-medium text-ink hover:text-primary">${esc(row.name)}</button>`;
        return `<tr class="transition hover:bg-surface-2/50">
            <td class="px-2 py-2.5">
              <input type="checkbox" data-tool-select="${esc(row.domain)}" class="h-3.5 w-3.5 rounded border-border"${checked}${locked ? ` disabled title="${esc(lockTitle)}"` : ""} aria-label="选择 ${esc(row.name)}" />
            </td>
            <td class="max-w-[240px] px-4 py-2.5">
              ${nameCell}
              <div class="mt-0.5 max-w-full truncate text-[11px] text-ink-muted">${esc(row.description ?? "")}</div>
            </td>
            <td class="px-4 py-2.5 text-xs">
              <a href="${esc(row.url || `https://${row.domain}`)}" target="_blank" rel="noopener" class="text-ink-secondary underline decoration-border underline-offset-2 transition hover:text-primary hover:decoration-primary" title="在新页面打开 ${esc(row.domain)}">${esc(row.domain)}</a>
            </td>
            <td class="px-4 py-2.5 text-right text-xs tabular-nums text-ink-secondary">${fmtNum(row.phUpvotes)}</td>
            <td class="px-4 py-2.5 text-right text-xs tabular-nums text-ink-secondary">${fmtVisits(row.monthlyVisits)}</td>
            <td class="max-w-[200px] px-4 py-2.5">
              ${tierBadge(row.tier)}
              <div class="mt-1 max-w-full truncate text-[11px] text-ink-muted" title="${esc(reason)}">${esc(reason)}</div>
            </td>
            <td class="px-4 py-2.5">${stageBadge(row.stage)}</td>
            <td class="px-4 py-2.5 text-right text-xs tabular-nums text-ink-secondary">${missing}</td>
            <td class="whitespace-nowrap px-4 py-2.5 text-right">
              ${
                // 可发布 = 富化完成，或上次发布失败（点一下就是重发，不必先回顶部勾选）
                row.stage === "enriched" || row.stage === "publish_failed"
                  ? `<button type="button" data-tool-publish="${esc(row.domain)}" class="mr-3 text-xs font-medium text-primary hover:underline">${row.stage === "publish_failed" ? "重新发布" : "发布"}</button>`
                  : row.stage === "publishing"
                    ? `<span class="mr-3 text-xs text-primary">发布中…</span>`
                    : row.stage === "published"
                      ? `<button type="button" data-tool-done="${esc(row.domain)}" class="mr-3 text-xs font-medium text-accent hover:underline" title="确认线上没问题后点这里，这条才会从后台消失">处理完成</button>`
                      : ""
              }
              <button type="button" data-tool-open="${esc(row.domain)}" class="text-xs text-ink-muted hover:text-primary hover:underline">详情</button>
              ${
                // 发布中/已发榜的条目不给拒绝入口：状态是流水线写的，直接拒会打架
                locked
                  ? ""
                  : `<button type="button" data-tool-reject="${esc(row.domain)}" data-tool-rejected="${row.rejected}" class="ml-3 text-xs text-ink-muted transition hover:text-danger">${row.rejected ? "恢复" : "拒绝"}</button>`
              }
            </td>
          </tr>`;
      })
      .join("");
  }

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  $("tools-staging-pager").innerHTML = `<span>第 ${data.page} / ${pages} 页</span>
      <span class="flex gap-3">
        <button type="button" data-tool-page="${data.page - 1}" ${data.page <= 1 ? 'class="cursor-not-allowed opacity-40" disabled' : 'class="text-primary hover:underline"'}>上一页</button>
        <button type="button" data-tool-page="${data.page + 1}" ${data.page >= pages ? 'class="cursor-not-allowed opacity-40" disabled' : 'class="text-primary hover:underline"'}>下一页</button>
      </span>`;

  // 阶段是这次刷新才变的（富化中 → 成功/失败），按钮可用性得跟着重算
  syncEnrichButton(state.jobs);
  syncDoneButton(data);
  // 翻页/换筛选会把不在本页的勾选清掉，按钮上的数字要跟着回落
  syncPublishButton(state.preview);
}

/** 下榜清单：存量重判的产出，没跑过就明确说「未知」而不是显示 0 */
function renderAudit(audit: PreviewResp["audit"]): void {
  const box = $("tools-audit");
  if (!box) return;

  if (!audit) {
    box.innerHTML = `<p class="text-ink-muted">还没重判过存量，下榜清单未知。点「重判存量」体检已在榜的条目，找出站点失效或流量跌破 1,000 的，再决定是否随本次发布一起下架。</p>`;
    return;
  }

  const head = `<p class="mb-1 font-medium text-ink">榜单变化（存量 ${fmtNum(audit.total)} 条）</p>`;
  const mode = `${audit.refreshedTraffic ? "已刷新流量" : "未刷新流量"}／${audit.probed ? "已探活" : "未探活"}`;

  if (!audit.dropCount) {
    const degraded = audit.degraded.length
      ? `<p class="mt-1 text-[11px] text-ink-muted">降级 ${audit.degraded.length} 条（主榜→观察）：${audit.degraded
          .slice(0, 6)
          .map((d) => esc(d.domain))
          .join("、")}</p>`
      : "";
    box.innerHTML = `${head}<p class="text-accent">没有条目需要下榜。</p>${degraded}<p class="mt-1 text-[11px] text-ink-muted">${mode}</p>`;
    return;
  }

  const rows = audit.dropped
    .map(
      (d) => `<div class="flex items-start justify-between gap-3 py-0.5">
        <span class="text-ink-secondary">${esc(d.domain)}</span>
        <span class="text-right text-[11px] text-danger">${esc(d.reason)}</span>
      </div>`,
    )
    .join("");

  box.innerHTML = `${head}<p class="mb-1 text-danger">将下榜 ${audit.dropCount} 条：</p>${rows}${
    audit.dropCount > audit.dropped.length
      ? `<p class="mt-1 text-[11px] text-ink-muted">… 其余 ${audit.dropCount - audit.dropped.length} 条见 content/tools-audit.json</p>`
      : ""
  }<p class="mt-1 text-[11px] text-ink-muted">${mode}</p>`;
}

/**
 * 勾选里真正能发出去的条数。
 *
 * 只有「待发布」（enriched）和「发布失败」（publish_failed）会进榜 ——
 * 与后端 markPublishing 的 where 条件同一口径。勾了待确认/待富化的条目也算勾选，
 * 但它们一条都发不出去，不能算进按钮上的数字。
 */
function publishableSelected(): number {
  const rows = state.staging?.items ?? [];
  return rows.filter(
    (r) => state.selected.has(r.domain) && (r.stage === "enriched" || r.stage === "publish_failed"),
  ).length;
}

/**
 * 「发布到榜单」按钮：数字必须是这一下真会发出去的条数。
 *
 * 以前直接写预览接口的 pending（队列里全部已富化条数），勾了 3 个照样显示 32，
 * 跟复选框完全对不上。现在：勾了就按勾选算，没勾才显示「全部 N」。
 */
function syncPublishButton(data: PreviewResp | null): void {
  if (!data) return;
  const btn = $("tools-publish-btn") as HTMLButtonElement;
  const text = $("tools-publish-preview");

  const pickedAll = state.selected.size;
  const picked = publishableSelected();

  if (!data.pending) {
    text.textContent = data.approved
      ? `已确认 ${data.approved} 个还没富化，先点「开始富化」。`
      : "没有已富化的条目：候选 → 确认收录 → 富化 → 才能发榜。";
    btn.disabled = true;
    btn.textContent = "发布到榜单";
    return;
  }

  if (pickedAll && !picked) {
    // 勾了却一条都发不出去：按钮必须点不动，否则点了没反应更迷惑
    text.textContent = `勾选的 ${pickedAll} 个都还没到「待发布」：要先富化，富化失败的先重新富化。`;
    btn.disabled = true;
    btn.textContent = "发布到榜单";
    return;
  }

  const n = pickedAll ? picked : data.pending;
  btn.disabled = false;
  // 没勾时标明「全部」：否则光看数字分不清是勾选数还是队列总数，正是矛盾感的来源
  btn.textContent = pickedAll ? `发布到榜单（${n}）` : `发布到榜单（全部 ${n}）`;

  const e = data.estimate;
  const retry = data.publishFailed ?? 0;
  const parts = [
    pickedAll
      ? `已选 ${pickedAll} 个，其中 ${picked} 个可发榜，其余状态会被跳过`
      : `将发布全部 ${data.pending} 个待发布条目${retry ? `（含 ${retry} 个上次失败的重发）` : ""}`,
  ];
  if (e) {
    if (e.dropCount) parts.push(`同时下榜 ${e.dropCount} 条`);
    if (e.listedAfter !== undefined) {
      parts.push(`榜单 ${fmtNum(e.listedBefore)} → ${fmtNum(e.listedAfter)} 条`);
    }
  }
  const tail = data.audit ? "，发布后自动触发站点构建。" : "。下榜清单还没算，建议先点「重判存量」。";
  text.textContent = parts.join("，") + tail;
}

function renderPreview(data: PreviewResp): void {
  state.preview = data;
  renderAudit(data.audit);
  syncPublishButton(data);
}

/** 字段体检面板：空置（补采可修）与异常（必须人工核对）分开看 */
function renderFieldReport(report: FieldReport | null): void {
  const box = $("tools-field-report");
  if (!report || !report.total) {
    box.innerHTML = `<p>还没有富化结果。确认收录后点「开始富化」，这里会显示各字段的空置与异常统计。</p>`;
    return;
  }

  const rows = report.dimensions
    .map((d) => {
      const invalid = d.invalid ?? 0;
      const invalidRatio = d.invalidRatio ?? 0;
      const missTone =
        d.missingRatio >= 50 ? "text-danger" : d.missingRatio > 0 ? "text-accent" : "text-ink-muted";
      const badTone = invalid > 0 ? "text-danger" : "text-ink-muted";
      return `<div class="flex items-center justify-between gap-3 py-0.5">
          <span class="text-ink-secondary">${esc(d.label)}</span>
          <span class="flex gap-4 tabular-nums">
            <span class="${missTone}">空 ${d.missing}（${d.missingRatio}%）</span>
            <span class="${badTone}">异常 ${invalid}（${invalidRatio}%）</span>
          </span>
        </div>`;
    })
    .join("");

  // 只列异常原因样例：空置的原因一目了然，异常的原因必须给出来才知道怎么修
  const samples = report.dimensions
    .filter((d) => (d.invalid ?? 0) > 0 && d.invalidSamples?.length)
    .flatMap((d) =>
      (d.invalidSamples ?? []).slice(0, 2).map(
        (s) => `<div class="flex items-start justify-between gap-3 py-0.5">
            <span class="text-ink-secondary">${esc(s.domain)}</span>
            <span class="text-right text-[11px] text-danger">${esc(d.label)}：${esc(s.reason)}</span>
          </div>`,
      ),
    )
    .join("");

  const entryIssues = (report.entryIssues ?? [])
    .slice(0, 5)
    .map(
      (e) => `<div class="flex items-start justify-between gap-3 py-0.5">
        <span class="text-ink-secondary">${esc(e.domain)}</span>
        <span class="text-right text-[11px] text-danger">${esc(e.label)}：${esc(e.reason)}</span>
      </div>`,
    )
    .join("");

  const worst = [...report.items]
    .sort((a, b) => b.gapCount + (b.issueCount ?? 0) - (a.gapCount + (a.issueCount ?? 0)))
    .slice(0, 5);
  const worstText = worst.length
    ? `<p class="mt-2 text-[11px] text-ink-muted">问题最多：${worst
        .map((i) => `${esc(i.domain)}（空 ${i.gapCount}／异常 ${i.issueCount ?? 0}）`)
        .join("、")}</p>`
    : "";

  const issueBlock =
    samples || entryIssues
      ? `<p class="mb-1 mt-2 font-medium text-ink">需要人工核对的异常</p>${samples}${entryIssues}`
      : "";

  box.innerHTML =
    `<p class="mb-1 font-medium text-ink">字段体检（已确认/已富化 ${report.total} 条` +
    `${report.itemsWithIssues ? `，${report.itemsWithIssues} 条有问题` : ""}）</p>` +
    `<p class="mb-1 text-[11px] text-ink-muted">空置＝没采到，补采可修；异常＝有值但不合法，补采也修不好</p>` +
    rows +
    issueBlock +
    worstText;
}

/* --------------------------------- 加载 --------------------------------- */

async function loadOverview(): Promise<void> {
  try {
    renderOverview(await apiGet<Overview>("/tools/overview"));
  } catch (e) {
    $("tools-setup").classList.remove("hidden");
    $("tools-setup-missing").textContent = `读取失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

async function loadJobs(): Promise<void> {
  try {
    const data = await apiGet<{ jobs: Job[] }>("/tools/jobs?limit=8");
    renderJobs(data.jobs ?? []);
  } catch {
    /* 任务列表失败不阻塞其它区域 */
  }
}

async function loadStaging(): Promise<void> {
  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: "50",
    tier: state.tier,
  });
  if (state.q) params.set("q", state.q);
  try {
    renderStaging(await apiGet<StagingResp>(`/tools/staging?${params.toString()}`));
  } catch (e) {
    $("tools-staging-meta").textContent = `读取失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

async function loadPreview(): Promise<void> {
  try {
    renderPreview(await apiGet<PreviewResp>("/tools/publish/preview"));
  } catch {
    $("tools-publish-preview").textContent = "发布预览读取失败";
    $("tools-publish-btn").setAttribute("disabled", "true");
  }
  void loadFieldReport();
}

async function loadFieldReport(): Promise<void> {
  try {
    const res = await apiGet<{ report: FieldReport | null }>("/tools/field-report");
    renderFieldReport(res.report);
  } catch {
    renderFieldReport(null);
  }
}

/** 有任务在跑就每 12 秒刷一次，跑完自动停 */
function schedulePolling(shouldRun: boolean): void {
  if (shouldRun && !state.polling) {
    state.polling = window.setInterval(() => {
      void loadJobs();
      void loadOverview();
      void loadStaging();
    }, 12_000);
  } else if (!shouldRun && state.polling) {
    window.clearInterval(state.polling);
    state.polling = undefined;
  }
}

/* -------------------------------- 详情抽屉 -------------------------------- */

interface DetailResp {
  tool: Record<string, unknown> & {
    domain: string;
    name?: string;
    url?: string;
    description?: string;
    phUpvotes?: number;
    categories?: string[];
    firstSeenAt?: string;
    heatScore?: number;
    trafficMetrics?: Record<string, unknown>;
    metrics?: Record<string, unknown>;
  };
  tier: "core" | "watch" | null;
  rejected: boolean;
}

function field(label: string, value: string): string {
  return `<div class="flex gap-3 border-b border-border py-2 last:border-b-0">
      <dt class="w-24 shrink-0 text-xs text-ink-muted">${esc(label)}</dt>
      <dd class="min-w-0 flex-1 break-words text-xs text-ink-secondary">${value}</dd>
    </div>`;
}

async function openDetail(domain: string): Promise<void> {
  const box = $("tools-detail");
  state.detailDomain = domain;
  box.classList.remove("hidden");
  box.classList.add("flex");
  $("tools-detail-name").textContent = "加载中…";
  $("tools-detail-domain").textContent = domain;
  $("tools-detail-body").innerHTML = `<p class="text-xs text-ink-muted">正在读取…</p>`;

  try {
    const data = await apiGet<DetailResp>(`/tools/staging/${encodeURIComponent(domain)}`);
    const t = data.tool;
    state.detailRejected = data.rejected;

    $("tools-detail-name").textContent = t.name ?? t.domain;
    $("tools-detail-domain").textContent = t.domain;

    const visits = (t.trafficMetrics?.monthlyVisits ?? t.metrics?.monthlyVisits) as number | undefined;
    const growth = (t.trafficMetrics?.monthlyVisitsGrowth ?? t.metrics?.momGrowth) as number | undefined;

    const rows = [
      field(
        "链接",
        t.url
          ? `<a href="${esc(t.url)}" target="_blank" rel="noopener" class="text-primary hover:underline">${esc(t.url)}</a>`
          : "—",
      ),
      field("描述", esc(t.description ?? "—")),
      field("收录判定", `${tierBadge(data.tier)}${data.rejected ? ' <span class="ml-1 text-[11px] text-ink-muted">（已拒绝）</span>' : ""}`),
      field("PH 赞", fmtNum(t.phUpvotes ?? 0)),
      field("月访问", fmtVisits(visits)),
      field("环比", typeof growth === "number" ? `${growth > 0 ? "+" : ""}${growth.toFixed(1)}%` : "—"),
      field("分类", (t.categories ?? []).map((c) => esc(c)).join(" · ") || "—"),
      field("首次发现", fmtTime(t.firstSeenAt)),
      field("热度分", fmtNum(t.heatScore)),
    ];

    const metrics = t.trafficMetrics ?? t.metrics;
    const metricRows = metrics
      ? Object.entries(metrics)
          .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
          .map(([k, v]) => field(k, esc(String(v))))
          .join("")
      : "";

    $("tools-detail-body").innerHTML = `<dl>${rows.join("")}</dl>
        ${metricRows ? `<h4 class="mb-1 mt-4 text-xs font-semibold text-ink">流量指标</h4><dl>${metricRows}</dl>` : ""}
        <details class="mt-4">
          <summary class="cursor-pointer text-xs text-ink-muted">原始 JSON</summary>
          <pre class="mt-2 max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 text-[11px] leading-relaxed text-ink-secondary">${esc(JSON.stringify(t, null, 2))}</pre>
        </details>`;

    ($("tools-detail-reject") as HTMLButtonElement).textContent = data.rejected
      ? "恢复这个工具"
      : "拒绝这个工具";
  } catch (e) {
    $("tools-detail-body").innerHTML = `<p class="text-xs text-danger">读取失败：${esc(e instanceof Error ? e.message : String(e))}</p>`;
  }
}

function closeDetail(): void {
  const box = $("tools-detail");
  box.classList.add("hidden");
  box.classList.remove("flex");
  state.detailDomain = "";
}

/* -------------------------------- 事件绑定 -------------------------------- */

async function rejectDomains(domains: string[], reject: boolean): Promise<void> {
  await apiPost("/tools/staging/reject", { domains, reject });
}

/** 确认收录 / 取消确认：只改 stage，不花钱、不抓取 */
async function approveDomains(domains: string[], approve: boolean): Promise<void> {
  await apiPost("/tools/staging/approve", { domains, approve });
}

/** 触发富化：单条约 $0.01（aitdk + SERP + LLM），仍是真花钱的动作，提交前必须确认 */
async function enrichDomains(domains: string[]): Promise<void> {
  await apiPost("/tools/enrich", {
    domains,
    limit: Math.max(1, Math.min(domains.length || 10, 20)),
    note: `后台富化 ${domains.length || "全部已确认"} 个`,
  });
}

/**
 * 发布到线上榜单。
 *
 * domains 非空 = 只发这些（后端仍会按「已富化」过滤）；空 = 队列里全部可发榜的。
 * 发布是唯一会改动线上榜单的动作，所以给两次确认：第一次说清范围，第二次说清后果。
 */
async function publishDomains(domains: string[]): Promise<boolean> {
  const total = (state.staging?.enriched ?? 0) + (state.staging?.publishFailed ?? 0);
  const sendable = domains.length ? publishableSelected() : total;
  const scope = domains.length
    ? `勾选的 ${domains.length} 个中的 ${sendable} 个可发榜条目`
    : `全部 ${total} 个可发榜条目`;

  if (
    !window.confirm(
      `确认发布${scope}？\n\n只有阶段是「可发榜」的条目会进榜，其余状态自动跳过。`,
    )
  ) {
    return false;
  }
  if (
    !window.confirm(
      `再确认一次：发布后会写入线上榜单（D1 新版本）并触发站点构建，约 2–5 分钟上线。\n\n确认发布？`,
    )
  ) {
    return false;
  }

  try {
    await apiPost("/tools/publish", { note: `后台发布 ${scope}`, domains });
  } catch (e) {
    window.alert(`发布失败：${e instanceof Error ? e.message : String(e)}`);
    // 状态可能已被别处改过（另一个窗口点了发布），拉一次真实状态，免得按钮一直点不动
    void loadStaging();
    void loadPreview();
    return false;
  }
  state.selected.clear();
  void loadJobs();
  void loadStaging();
  void loadPreview();
  window.alert(
    `已提交发布：${scope}。\n\n构建约 2–5 分钟，期间列表里这些条目标「发布中」。\n完成后变成「发布成功」，确认线上没问题再点「处理完成」把这条移出后台。`,
  );
  return true;
}

function bind(): void {
  /*
   * 「线上榜单」提交更新/发布后要让顶部运行记录立刻出现「运行中」。
   * 任务列表的轮询归这个模块管，那边提交完没有 loadJobs 的机会，
   * 所以由它发事件、这里接住 —— 比把 loadJobs 挂到 window 上干净。
   */
  window.addEventListener("horizons:jobs-changed", () => void loadJobs());

  $("tools-fetch-count").addEventListener("change", updateFetchEstimate);
  $("tools-fetch-enrich").addEventListener("change", updateFetchEstimate);
  // input 而不是 change：粘贴一长串域名时要立刻反映条数，等失焦才更新会让人以为没生效
  $("tools-fetch-domains").addEventListener("input", updateFetchEstimate);
  updateFetchEstimate();
  mountTopicPicker();

  $("tools-fetch-btn").addEventListener("click", async () => {
    const btn = $("tools-fetch-btn") as HTMLButtonElement;
    const domains = parseDomainsInput();
    const raw = ($("tools-fetch-domains") as HTMLTextAreaElement).value.trim();
    if (raw && domains.length === 0) {
      window.alert("指定网站里没有解析出有效域名：填形如 picvo.ai 的域名或 https:// 开头的链接。");
      return;
    }
    /** 与后端 MAX_MANUAL_DOMAINS / 脚本 MAX_MANUAL 一致，只是提前拦一次，省得白跑一次 job */
    const MAX_MANUAL = 50;
    if (domains.length > MAX_MANUAL) {
      window.alert(`一次最多指定 ${MAX_MANUAL} 个站点，当前 ${domains.length} 个，请分批提交。`);
      return;
    }

    const count = domains.length || Number(($("tools-fetch-count") as HTMLSelectElement).value);
    const order = ($("tools-fetch-order") as HTMLSelectElement).value;
    const topic =
      ($("tools-fetch-topic") as HTMLInputElement).value.trim() || "artificial-intelligence";
    const enrich = ($("tools-fetch-enrich") as HTMLInputElement).checked;

    btn.disabled = true;
    btn.textContent = "提交中…";
    try {
      await apiPost("/tools/jobs", {
        count,
        order,
        topic,
        enrich,
        ...(domains.length ? { domains } : {}),
      });
      btn.textContent = "已提交";
      void loadJobs();
      window.setTimeout(() => {
        btn.disabled = false;
        btn.textContent = "开始抓取";
      }, 4000);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "开始抓取";
      window.alert(`提交失败：${e instanceof Error ? e.message : String(e)}`);
    }
  });

  $("tools-publish-btn").addEventListener("click", async () => {
    const btn = $("tools-publish-btn") as HTMLButtonElement;
    if (btn.disabled) return;
    // 勾了提交勾选的（后端只放行已富化的），没勾提交全部可发榜的
    const picked = [...state.selected];
    // 发布失败待重发的也算可发榜，否则「全量发布」会被这个前置检查拦掉
    const total = (state.staging?.enriched ?? 0) + (state.staging?.publishFailed ?? 0);
    if (!picked.length && !total) {
      window.alert("没有可发榜的条目：先富化，阶段变成「可发榜」之后才能发布。");
      return;
    }

    btn.disabled = true;
    btn.textContent = "提交中…";
    try {
      if (!(await publishDomains(picked))) {
        // 用户在半路取消：按钮要立刻恢复（含数字），不然看起来像已经在发布了
        syncPublishButton(state.preview);
        return;
      }
      btn.textContent = "已提交";
      window.setTimeout(() => {
        void loadPreview();
      }, 4000);
    } catch (e) {
      syncPublishButton(state.preview);
      window.alert(`发布失败：${e instanceof Error ? e.message : String(e)}`);
    }
  });

  $("tools-staging-refresh").addEventListener("click", () => {
    void loadStaging();
    void loadPreview();
    void loadOverview();
  });

  ($("tools-staging-tier") as HTMLSelectElement).addEventListener("change", (event) => {
    state.tier = (event.target as HTMLSelectElement).value;
    state.page = 1;
    void loadStaging();
  });

  $("tools-staging-search").addEventListener(
    "input",
    debounce(() => {
      state.q = ($("tools-staging-search") as HTMLInputElement).value.trim();
      state.page = 1;
      void loadStaging();
    }),
  );

  // 表格内容是动态渲染的，统一用事件委托
  $("tools-staging-body").addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const open = target.closest<HTMLElement>("[data-tool-open]");
    if (open?.dataset.toolOpen) {
      void openDetail(open.dataset.toolOpen);
      return;
    }

    // 行内「发布」：只发布这一条已富化的，不用先回顶部勾选
    const publish = target.closest<HTMLElement>("[data-tool-publish]");
    if (publish?.dataset.toolPublish) {
      void publishDomains([publish.dataset.toolPublish]);
      return;
    }

    /*
     * 行内「处理完成」：发布成功不会自动消失，得人确认线上没问题后手动收尾。
     * 二次确认是必须的 —— 删掉后要看这条的历史只能去榜单 JSON 里翻。
     */
    const done = target.closest<HTMLElement>("[data-tool-done]");
    if (done?.dataset.toolDone) {
      const domain = done.dataset.toolDone;
      if (
        !window.confirm(
          `确认「${domain}」已经上线且一切正常？\n\n点「确定」后这条会从后台队列移除，线上榜单不受影响。`,
        )
      ) {
        return;
      }
      done.setAttribute("disabled", "true");
      void apiPost<{ removed: number; skipped: number }>("/tools/staging/done", { domains: [domain] })
        .then((r) => {
          if (!r.removed) {
            window.alert("这条不在「发布成功」状态，没有删除。刷新一下看最新状态。");
            done.removeAttribute("disabled");
            return;
          }
          void loadStaging();
          void loadOverview();
        })
        .catch((e) => {
          done.removeAttribute("disabled");
          window.alert(`操作失败：${e instanceof Error ? e.message : String(e)}`);
        });
      return;
    }

    const reject = target.closest<HTMLElement>("[data-tool-reject]");
    if (reject?.dataset.toolReject) {
      const domain = reject.dataset.toolReject;
      const wasRejected = reject.dataset.toolRejected === "true";
      void rejectDomains([domain], !wasRejected)
        .then(() => {
          void loadStaging();
          void loadPreview();
          void loadOverview();
        })
        .catch((e) => window.alert(`操作失败：${e instanceof Error ? e.message : String(e)}`));
    }
  });

  // 勾选（表格内容动态渲染，同样用委托）
  $("tools-staging-body").addEventListener("change", (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>("[data-tool-select]");
    if (!input?.dataset.toolSelect) return;
    if (input.checked) state.selected.add(input.dataset.toolSelect);
    else state.selected.delete(input.dataset.toolSelect);
    // 勾选直接决定「这批能不能富化/能发几条」，按钮要立刻跟着变，不等接口
    syncEnrichButton(state.jobs);
    syncPublishButton(state.preview);
    void loadPreview();
  });

  $("tools-select-all").addEventListener("change", (event) => {
    const on = (event.target as HTMLInputElement).checked;
    state.selected.clear();
    if (on) {
      // 跳过富化中/发布中的行（已被任务占用）和已发榜的行（等人工点「处理完成」）
      for (const row of state.staging?.items ?? []) {
        if (row.stage === "enriching" || row.stage === "publishing" || row.stage === "published") {
          continue;
        }
        state.selected.add(row.domain);
      }
    }
    syncEnrichButton(state.jobs);
    syncPublishButton(state.preview);
    void loadStaging();
    void loadPreview();
  });

  /*
   * 批量处理完成：发布成功的条目会停在队列里等人工确认，逐条点太慢。
   * 只收尾 published —— 发布中/发布失败/待富化的一条都不动。
   * 二次确认把数量和「不影响线上」说清楚，避免手滑清空整批。
   */
  $("tools-done-btn").addEventListener("click", async () => {
    const btn = $("tools-done-btn") as HTMLButtonElement;
    const n = state.staging?.published ?? 0;
    if (!n) {
      window.alert("没有「发布成功」的条目需要收尾。");
      return;
    }
    if (
      !window.confirm(
        `确认批量处理完成？\n\n将把 ${n} 条「已发布成功」的条目移出后台队列。\n\n` +
          `· 线上榜单不受影响，只是后台不再显示\n` +
          `· 发布中 / 发布失败 / 待富化的条目一条都不会动\n` +
          `· 操作不可撤销\n\n确定继续？`,
      )
    ) {
      return;
    }
    btn.disabled = true;
    btn.textContent = "处理中…";
    try {
      const r = await apiPost<{ removed: number; skipped: number }>("/tools/staging/done", {
        all: true,
      });
      state.selected.clear();
      await loadStaging();
      void loadPreview();
      void loadOverview();
      if (!r.removed) window.alert("没有条目被移除，刷新一下看最新状态。");
    } catch (e) {
      window.alert(`批量处理失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // loadStaging 会重渲染并复位按钮；请求失败时也要把文案恢复
      if (state.staging) {
        syncDoneButton(state.staging);
      } else {
        btn.disabled = false;
        btn.textContent = "批量处理完成";
      }
    }
  });

  $("tools-approve-btn").addEventListener("click", async () => {
    const domains = [...state.selected];
    if (!domains.length) {
      window.alert("先勾选要确认收录的条目");
      return;
    }
    const btn = $("tools-approve-btn") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "提交中…";
    try {
      await approveDomains(domains, true);
      state.selected.clear();
      await loadStaging();
      void loadPreview();
      void loadOverview();
    } catch (e) {
      window.alert(`确认失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "确认收录";
    }
  });

  $("tools-reject-btn").addEventListener("click", async () => {
    const domains = [...state.selected];
    if (!domains.length) {
      window.alert("先勾选要拒绝的条目（可点表头复选框全选当前页）");
      return;
    }
    if (
      !window.confirm(
        `确认拒绝选中的 ${domains.length} 个？\n拒绝后这些域名进入永久不抓取名单，采集时会直接跳过。\n` +
          `（误操作可在「已拒绝」筛选里单条恢复）`,
      )
    ) {
      return;
    }

    const btn = $("tools-reject-btn") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "提交中…";
    try {
      // 后端单次最多收 100 个域名，多选时分批发，避免「点了全选只拒掉一部分」
      for (let i = 0; i < domains.length; i += 100) {
        await rejectDomains(domains.slice(i, i + 100), true);
      }
      state.selected.clear();
      await loadStaging();
      void loadPreview();
      void loadOverview();
    } catch (e) {
      window.alert(`批量拒绝失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "批量拒绝";
    }
  });

  $("tools-enrich-btn").addEventListener("click", async () => {
    const btn = $("tools-enrich-btn") as HTMLButtonElement;
    if (btn.disabled) return;

    const rows = state.staging?.items ?? [];
    // 富化中的条目已被任务占住，无论勾没勾到都不能再进这批
    const domains = [...state.selected].filter((d) => {
      const r = rows.find((x) => x.domain === d);
      return !r || r.stage !== "enriching";
    });
    // 只有「待富化 / 富化失败」会被真正送去跑（后端 markEnriching 也限这两种状态），
    // 勾了已富化的条目不能算进费用，否则估算和实际执行对不上
    // 单批上限跟后端一致（接口最多 20 条）：多的不截断的话，
    // 报价按 30 条算、实际只跑 20 条，剩下的还会被标成富化中然后超时失败
    const MAX_ENRICH_BATCH = 20;
    const picked = (domains.length
      ? rows.filter((r) => state.selected.has(r.domain) && canEnrich(r))
      : rows.filter(canEnrich)
    ).slice(0, MAX_ENRICH_BATCH);

    // 没勾选时按队列里的待富化总数估算（当前页可能只显示一部分）
    const est = domains.length
      ? estimateEnrich(picked)
      : estimateEnrich(
          picked,
          Math.min(
            // 没勾选时后端跑「全部可富化的」：待富化 + 富化失败的都算
            (state.staging?.approved ?? 0) + (state.staging?.enrichFailed ?? 0) ||
              picked.length,
            MAX_ENRICH_BATCH,
          ),
        );

    if (!est.count) {
      window.alert(
        "没有可富化的条目。\n\n只能富化「待富化 / 富化失败」的条目：\n" +
          "· 富化中的条目正在跑，等它结束再提交（不会重复计费）\n" +
          "· 已富化的条目不用再跑（要重跑请先确认收录）",
      );
      return;
    }

    // 第一次确认：把账算清楚 —— 流量快照复用准入缓存，实际只花 aitdk + SERP + LLM
    const detail =
      (domains.length > MAX_ENRICH_BATCH
        ? `注意：单批最多 ${MAX_ENRICH_BATCH} 条，本次只处理前 ${MAX_ENRICH_BATCH} 条，其余的跑完再提交。\n\n`
        : "") +
      `将对 ${est.count} 个条目做富化（单条 2–5 分钟）。\n\n` +
      `· 单条约 $${est.perSite.toFixed(4)}：aitdk 数据 $0.002 + Google 搜索 3 条 $0.0075 + AI 抽取 $0.001\n` +
      `· 流量快照复用准入阶段的采集缓存，不再重复收费\n` +
      (est.fallback
        ? `· 其中 ${est.fallback} 条流量数据不足，会补备选源：${est.fallback} × $${ENRICH_COST.fallback} = $${(est.fallback * ENRICH_COST.fallback).toFixed(3)}\n`
        : "") +
      `\n预计合计约 $${est.total.toFixed(2)}${est.rough ? "（队列未全量展示，此为上限估算）" : ""}。\n继续？`;
    if (!window.confirm(detail)) return;

    // 第二次确认：这是会真扣钱的操作，再问一遍
    if (
      !window.confirm(
        `再确认一次：提交后立即开始扣费，预计 $${est.total.toFixed(2)}。\n` +
          `任务跑完之前不能重复提交，也无法中途退款。\n\n确认提交富化？`,
      )
    ) {
      return;
    }

    btn.disabled = true;
    btn.textContent = "已提交";
    try {
      // 只把这些真正要跑的域名传下去：带上已富化的条目会被脚本 --domains 强制重跑
      await enrichDomains(domains.length ? picked.map((r) => r.domain) : []);
      // 派发成功就本地占位：库里要等 markEnriching 才变 enriching，
      // 这段空窗里按钮不该再亮起来（重复点就是重复扣费）
      const at = Date.now();
      for (const r of picked) state.enrichPending.set(r.domain, at);
      state.selected.clear();
      syncEnrichButton(state.jobs);
      void loadJobs();
      void loadStaging();
      void loadPreview();
    } catch (e) {
      syncEnrichButton(state.jobs);
      window.alert(`富化提交失败：${e instanceof Error ? e.message : String(e)}`);
    }
  });

  $("tools-audit-btn").addEventListener("click", async () => {
    if (
      !window.confirm(
        "将重新查询已在榜条目的流量并做存活探测（约 5 分钟，花费约 $0.002）。\n" +
          "跑完这里会显示「将下榜 N 条」，不会自动删除任何条目。",
      )
    ) {
      return;
    }
    const btn = $("tools-audit-btn") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "已提交";
    try {
      await apiPost("/tools/audit", {});
      void loadJobs();
      window.setTimeout(() => {
        btn.disabled = false;
        btn.textContent = "重判存量";
        void loadPreview();
      }, 6000);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "重判存量";
      window.alert(`重判提交失败：${e instanceof Error ? e.message : String(e)}`);
    }
  });

  $("tools-staging-pager").addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>("[data-tool-page]");
    const page = Number(btn?.dataset.toolPage);
    if (!page || page === state.page) return;
    state.page = page;
    void loadStaging();
  });

  $("tools-detail-close").addEventListener("click", closeDetail);
  $("tools-detail").addEventListener("click", (event) => {
    if (event.target === $("tools-detail")) closeDetail();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.detailDomain) closeDetail();
  });

  $("tools-detail-reject").addEventListener("click", async () => {
    const domain = state.detailDomain;
    if (!domain) return;
    const btn = $("tools-detail-reject") as HTMLButtonElement;
    btn.disabled = true;
    try {
      await rejectDomains([domain], !state.detailRejected);
      closeDetail();
      void loadStaging();
      void loadPreview();
      void loadOverview();
    } catch (e) {
      window.alert(`操作失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      btn.disabled = false;
    }
  });
}

/* --------------------------------- 入口 --------------------------------- */

/** 首次切到页签时挂载；重复调用只刷新数据 */
export function mountAdminTools(): void {
  // 二级 tab（数据抓取 / 线上榜单）的绑定放在独立的模块里，
  // 这个文件已经 1400 多行，再塞一个表格渲染器就没人读得动了
  mountToolsListed();

  if (state.mounted) {
    void loadOverview();
    void loadJobs();
    void loadStaging();
    void loadPreview();
    return;
  }

  state.mounted = true;
  bind();
  void loadOverview();
  void loadJobs();
  void loadStaging();
  void loadPreview();
}