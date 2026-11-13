/**
 * 文档第 2 节的「上线时间证据链」+ 第 6 节的 GitHub 仓库信息。
 *
 * 五个来源互相独立，任何一个挂掉都不影响其他：Wayback CDX、Common Crawl Index、
 * 证书透明度日志（crt.sh）、GitHub REST、以及官网 JSON-LD/SERP 里的发布日期。
 * 最后按「证据强度 + 时间一致性」推一个上线日期和可信度。
 *
 * 这些接口全部免费、无 key，代价是会被网络环境影响（国内直连经常不通），
 * 所以失败一律记 error 而不抛，页面能看出「是没采到还是源挂了」。
 */
import { getJson, httpGet } from "./util";

export interface WaybackEvidence {
  timestamp?: string;
  url?: string;
  statuscode?: string;
  /** 最早返回 200 的快照状态（与最早存档不是同一条时更可信） */
  okStatuscode?: string;
  okTimestamp?: string;
  error?: string;
}

/** CDX 的 timestamp 是 14 位纯数字（YYYYMMDDhhmmss），转成 ISO 便于比较和展示 */
function cdxToIso(ts: string | undefined): string | undefined {
  if (!ts || ts.length < 8) return undefined;
  const y = ts.slice(0, 4);
  const mo = ts.slice(4, 6);
  const d = ts.slice(6, 8);
  const h = ts.slice(8, 10) || "00";
  const mi = ts.slice(10, 12) || "00";
  const s = ts.slice(12, 14) || "00";
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

/**
 * Wayback 最早快照。
 *
 * 查两次：一次不带过滤（最早存档时间/地址/状态，这是文档要的三个字段），
 * 一次只要 200（用于判断「最早那条是不是有效页面」，最早快照常见 301/404）。
 */
export async function waybackEvidence(domain: string): Promise<WaybackEvidence> {
  const base = "https://web.archive.org/cdx/search/cdx";
  const first = await getWithRetry(
    `${base}?url=${encodeURIComponent(domain)}&output=json&limit=1&fl=timestamp,original,statuscode`,
    25_000,
  );

  if (!first.ok) return { error: `CDX 请求失败（HTTP ${first.status || "无响应"}）${first.error ? `：${first.error}` : ""}` };

  const text = first.text.trim();
  if (!text) return { error: "CDX 无该域名存档记录" };

  let rows: string[][];
  try {
    rows = JSON.parse(text) as string[][];
  } catch {
    return { error: "CDX 返回非 JSON（可能被限流）" };
  }
  // [["timestamp","original","statuscode"], ["20190613...","http://x/","200"]]
  const row = rows[1];
  if (!row) return { error: "CDX 无该域名存档记录" };

  const out: WaybackEvidence = {
    timestamp: cdxToIso(row[0]),
    url: row[1],
    statuscode: row[2],
  };

  const ok = await httpGet(
    `${base}?url=${encodeURIComponent(domain)}&output=json&limit=1&fl=timestamp,statuscode&filter=statuscode:200`,
    { timeoutMs: 20_000 },
  );
  if (ok.ok && ok.text.trim()) {
    try {
      const okRows = JSON.parse(ok.text) as string[][];
      const okRow = okRows[1];
      if (okRow) {
        out.okTimestamp = cdxToIso(okRow[0]);
        out.okStatuscode = okRow[1];
      }
    } catch {
      /* 拿不到就只给最早快照，不影响主字段 */
    }
  }
  return out;
}

export interface CommonCrawlEvidence {
  timestamp?: string;
  url?: string;
  crawl?: string;
  error?: string;
}

interface CrawlInfo {
  id?: string;
  name?: string;
  "cdx-api"?: string;
}

/**
 * Common Crawl 首次抓取。
 *
 * 只能按索引逐个查（每个索引是一次月度抓取，形态是 NDJSON）。为了不把一次采集
 * 拖成几十个请求，从最老的索引往前查，最多 12 个；全部落空再查最新的 3 个——
 * 新站只可能出现在最近的抓取里，这样能少走一半弯路。
 */
export async function commonCrawlEvidence(domain: string): Promise<CommonCrawlEvidence> {
  const info = await getJson<CrawlInfo[]>("https://index.commoncrawl.org/collinfo.json", { timeoutMs: 25_000 });
  const crawls = (info.data ?? []).filter((c) => c["cdx-api"]);
  if (!crawls.length) return { error: info.error ?? "拿不到 Common Crawl 索引列表" };

  // collinfo 是「最新在前」，这里切成最老 12 个 + 最新 3 个
  const oldest = crawls.slice(-12);
  const newest = crawls.slice(0, 3);
  const queue = [...oldest, ...newest.filter((c) => !oldest.includes(c))];

  let lastError = "";
  for (const crawl of queue) {
    const api = crawl["cdx-api"]!;
    const url = `${api}?url=${encodeURIComponent(domain)}/*&output=json&limit=1`;
    // 索引服务对同一秒的并发请求经常直接 503，重试一次就能过，别把它记成「无记录」
    let res = await httpGet(url, { timeoutMs: 15_000, maxBytes: 256 * 1024 });
    if (!res.ok && (res.status === 503 || res.status === 502 || res.status === 429 || !res.status)) {
      await new Promise((r) => setTimeout(r, 1500));
      res = await httpGet(url, { timeoutMs: 20_000, maxBytes: 256 * 1024 });
    }
    if (!res.ok) {
      lastError = `HTTP ${res.status || "无响应"}`;
      continue;
    }
    const line = res.text.split("\n").find((l) => l.trim().startsWith("{"));
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as { timestamp?: string; url?: string };
      if (obj.timestamp) {
        return { timestamp: cdxToIso(obj.timestamp), url: obj.url, crawl: crawl.id };
      }
    } catch {
      lastError = "返回内容无法解析";
    }
  }
  return { error: `所有索引均无记录${lastError ? `（最后错误：${lastError}）` : ""}` };
}

export interface SslEvidence {
  notBefore?: string;
  issuer?: string;
  source?: string;
  error?: string;
}

interface CrtShRow {
  not_before?: string;
  name_value?: string;
  issuer_name?: string;
}

/**
 * 证书透明度日志里的最早签发时间。
 *
 * 文档写的是 crt.live，但 crt.live 目前没有可匿名访问的 JSON 查询接口（各路径均 404），
 * 所以先试一次它的常见路径，失败就用 crt.sh —— 同属 CT 日志聚合，字段名 not_before 一致。
 * 返回里的 source 会写明到底是哪一个，页面上一眼能看出文档的源可用性。
 */
export async function sslEvidence(domain: string): Promise<SslEvidence> {
  const crtLiveCandidates = [
    `https://crt.live/api/v1/precerts?domain=${encodeURIComponent(domain)}`,
    `https://crt.live/api/v1/query?domain=${encodeURIComponent(domain)}`,
  ];
  for (const url of crtLiveCandidates) {
    const res = await httpGet(url, { timeoutMs: 12_000, maxBytes: 512 * 1024 });
    if (!res.ok) continue;
    try {
      const data = JSON.parse(res.text) as unknown;
      const dates = collectNotBefore(data);
      if (dates.length) return { notBefore: dates.sort()[0], source: "crt.live" };
    } catch {
      /* 继续试下一个 */
    }
  }

  // crt.sh 经常在 30 秒边界上超时/502，重试一次（第二次放宽到 45s）
  const crtShUrl = `https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`;
  let res = await httpGet(crtShUrl, { timeoutMs: 30_000, maxBytes: 3 * 1024 * 1024 });
  if (!res.ok) {
    await new Promise((r) => setTimeout(r, 2000));
    res = await httpGet(crtShUrl, { timeoutMs: 45_000, maxBytes: 3 * 1024 * 1024 });
  }
  if (!res.ok) return { error: `crt.sh 请求失败（HTTP ${res.status || "无响应"}）` };
  const text = res.text.trim();
  if (!text) return { error: "crt.sh 返回空响应（该服务对热点域名经常超时）" };
  try {
    const rows = JSON.parse(text) as CrtShRow[];
    const dates = rows.map((r) => r.not_before).filter((d): d is string => !!d).sort();
    if (!dates.length) return { error: "crt.sh 无该域名证书记录" };
    const first = rows.find((r) => r.not_before === dates[0]);
    return { notBefore: dates[0], issuer: first?.issuer_name, source: "crt.sh" };
  } catch {
    return { error: "crt.sh 返回非 JSON（通常是被限流或网关 502）" };
  }
}

/** Wayback 的 CDX 偶发 fetch failed（DNS/连接被掐），重试一次就够，别拖长采集时间 */
async function getWithRetry(url: string, timeoutMs: number): Promise<Awaited<ReturnType<typeof httpGet>>> {
  let res = await httpGet(url, { timeoutMs });
  if (!res.ok && (res.status === 0 || res.status >= 500)) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await httpGet(url, { timeoutMs });
  }
  return res;
}

/** 递归找 not_before / first_seen 类字段，crt.live 的结构没公开文档，按值找最稳 */
function collectNotBefore(data: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || v == null) return;
    if (Array.isArray(v)) {
      for (const it of v) walk(it, depth + 1);
      return;
    }
    if (typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === "string" && /not_before|first_seen/i.test(k) && /^\d{4}-\d{2}-\d{2}/.test(val)) {
          out.push(val.slice(0, 10));
        } else {
          walk(val, depth + 1);
        }
      }
    }
  };
  walk(data, 0);
  return out;
}

/* -------------------------------- GitHub -------------------------------- */

export interface GithubRepo {
  fullName: string;
  htmlUrl: string;
  createdAt?: string;
  pushedAt?: string;
  stars?: number;
  forks?: number;
  description?: string;
  error?: string;
}

function ghHeaders(): Record<string, string> {
  const t = process.env.GH_API_TOKEN || process.env.GITHUB_TOKEN || "";
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
  };
}

/** 从官网链接里挑出最像「官方仓库」的 github owner/repo */
export function pickRepoFromLinks(links: { href: string; text?: string }[]): string | null {
  const skipOwners = new Set([
    "features",
    "topics",
    "about",
    "pricing",
    "login",
    "join",
    "sponsors",
    "marketplace",
    "collections",
    "events",
    "explore",
    "apps",
    "settings",
    "site",
    "security",
  ]);
  const counts = new Map<string, number>();
  for (const l of links) {
    const m = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/.exec(l.href);
    if (!m) continue;
    const [, owner, repo] = m;
    if (skipOwners.has(owner.toLowerCase())) continue;
    if (repo.endsWith(".git")) continue;
    if (/^(issues|pulls|blob|tree|releases|wiki|actions|discussions)$/i.test(repo)) continue;
    const key = `${owner}/${repo}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (!counts.size) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export async function fetchGithubRepo(fullName: string): Promise<GithubRepo> {
  const res = await getJson<{
    full_name?: string;
    html_url?: string;
    created_at?: string;
    pushed_at?: string;
    stargazers_count?: number;
    forks_count?: number;
    description?: string;
    message?: string;
  }>(`https://api.github.com/repos/${fullName}`, { timeoutMs: 20_000, headers: ghHeaders() });

  if (!res.data) return { fullName, htmlUrl: `https://github.com/${fullName}`, error: res.error ?? `HTTP ${res.status}` };
  if (res.data.message) return { fullName, htmlUrl: `https://github.com/${fullName}`, error: res.data.message };

  return {
    fullName: res.data.full_name ?? fullName,
    htmlUrl: res.data.html_url ?? `https://github.com/${fullName}`,
    createdAt: res.data.created_at?.slice(0, 10),
    pushedAt: res.data.pushed_at?.slice(0, 10),
    stars: res.data.stargazers_count,
    forks: res.data.forks_count,
    description: res.data.description,
  };
}

/* ------------------------------ 上线日期推算 ------------------------------ */

export interface LaunchInputs {
  releaseDate?: string;
  githubCreatedAt?: string;
  /** WHOIS 注册日（aitdk 副产物）：真实上线不可能早于它 */
  domainRegisteredAt?: string;
  /** Wayback 首条记录（可能是 301，只代表域名解析，不代表页面存在） */
  waybackTimestamp?: string;
  /** Wayback 首个 200 记录：这才是「页面确实存在」的上界 */
  waybackOkTimestamp?: string;
  commonCrawlTimestamp?: string;
  sslFirstSeen?: string;
}

export interface LaunchConclusion {
  date: string | null;
  confidence: string;
  score: number;
  note: string;
}

const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

interface LaunchCandidate {
  date: string;
  weight: number;
  label: string;
  /** 精确值（官方发布日）：不当下界用，直接采信 */
  exact?: boolean;
}

/**
 * 多来源推算上线日期。
 *
 * 证据分两类，混在一起比权重是上一版的错误来源：
 *   下界（真实上线不早于它）：域名注册、证书签发、GitHub 建仓、官方发布日
 *   上界（真实上线不晚于它）：首次网页存档/爬虫抓取
 *
 * cliputils 就是这么错的：Wayback 首条是 2026-10-07 的 301（只有域名解析，
 * 页面还没建），权重却排第一，于是把上线日推到 10-07，比 WHOIS 注册日晚了 80 天；
 * 同期 SSL 证书 07-19 签发、8 月就有流量，两个证据都指向 7 月。
 *
 * 现在的规则：
 *   1. 存档只用 200 记录（waybackOkTimestamp），301 不参与；
 *   2. 下界取「最晚」的一个 —— 所有下界都成立之后站点才可能上线；
 *   3. 上界只用来判断下界是否失真：跨度 ≤90 天加可信度分，缺上界不加分。
 */
export function concludeLaunchDate(inputs: LaunchInputs): LaunchConclusion {
  const pick = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : undefined);

  const release = pick(inputs.releaseDate);
  const github = pick(inputs.githubCreatedAt);
  const registered = pick(inputs.domainRegisteredAt);
  const ssl = pick(inputs.sslFirstSeen);
  const waybackOk = pick(inputs.waybackOkTimestamp) ?? pick(inputs.waybackTimestamp);
  const crawl = pick(inputs.commonCrawlTimestamp);

  const upper = [waybackOk, crawl].filter((d): d is string => !!d).sort()[0];

  const lowers: LaunchCandidate[] = [];
  if (release) lowers.push({ date: release, weight: 4, label: "官方发布日", exact: true });
  if (github) lowers.push({ date: github, weight: 3.5, label: "GitHub 建仓" });
  if (registered) lowers.push({ date: registered, weight: 3.5, label: "域名注册" });
  if (ssl) lowers.push({ date: ssl, weight: 2.8, label: "证书首次签发" });

  if (!lowers.length && !upper) {
    return { date: null, confidence: "无证据", score: 0, note: "六个来源全部无数据" };
  }

  // 只有上界：能说「最晚这天已经在线」，说不出更早，一律低可信
  if (!lowers.length && upper) {
    return {
      date: upper,
      confidence: "低",
      score: 40,
      note: `只有上界证据：首次网页存档/抓取 ${upper}（真实上线可能更早，缺注册日/证书/发布日可校正）`,
    };
  }

  const exact = lowers.find((c) => c.exact);
  // 同一天时取权重更高的那条（cliputils 的域名注册 16:48 与证书 16:06 是同一天，
  // 按字符串比大小会把「证书」排到前面，主证据就变成了弱证据）
  const latest = [...lowers].sort((a, b) => {
    const diff = Date.parse(b.date) - Date.parse(a.date);
    return diff !== 0 ? diff : b.weight - a.weight;
  })[0];
  const primary = exact ?? latest;

  const agree = lowers.filter((c) => c !== primary && dayDiff(c.date, primary.date) <= 45);
  const gapDays = upper ? dayDiff(upper, primary.date) : null;

  let score = primary.weight * 18 + agree.length * 9;
  if (gapDays !== null && gapDays <= 90) score += 12;
  else if (gapDays !== null && gapDays <= 180) score += 6;
  score = Math.min(100, Math.round(score));
  const confidence = score >= 80 ? "高" : score >= 55 ? "中" : "低";

  const chain = [
    ...lowers.map((c) => `${c.label} ${c.date}`),
    ...(upper ? [`首次网页存档/抓取（上界） ${upper}`] : []),
  ].join("；");

  const note =
    `主证据：${primary.label}（${primary.date}，${primary.exact ? "精确值" : "下界"}）` +
    (agree.length ? `；一致下界 ${agree.length} 个（±45 天）` : "；无其它下界相互印证") +
    (gapDays !== null ? `；上界 ${upper}（相差 ${Math.round(gapDays)} 天）` : "") +
    `。全部证据：${chain}`;

  return { date: primary.date, confidence, score, note };
}