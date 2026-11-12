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
  const first = await httpGet(`${base}?url=${encodeURIComponent(domain)}&output=json&limit=1&fl=timestamp,original,statuscode`, {
    timeoutMs: 25_000,
  });

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
    const res = await httpGet(`${api}?url=${encodeURIComponent(domain)}/*&output=json&limit=1`, {
      timeoutMs: 15_000,
      maxBytes: 256 * 1024,
    });
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

  const res = await httpGet(`https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`, {
    timeoutMs: 40_000,
    maxBytes: 3 * 1024 * 1024,
  });
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
  waybackTimestamp?: string;
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

/**
 * 多来源推算上线日期。
 *
 * 优先级按证据强度排：官方发布日 > GitHub 建仓日 > 网页存档/爬虫首抓（取更早者）> 证书签发。
 * 不能用「取最早」的简单规则 —— 证书经常比上线早半年（先买域名），
 * 那会把上线日期整体往前拉，反而更不准。
 *
 * 可信度 = 主证据强度 + 其他来源在 ±1 年内的一致性；单一弱证据（只有证书）一律低。
 */
export function concludeLaunchDate(inputs: LaunchInputs): LaunchConclusion {
  const pick = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : undefined);

  const release = pick(inputs.releaseDate);
  const github = pick(inputs.githubCreatedAt);
  const wayback = pick(inputs.waybackTimestamp);
  const crawl = pick(inputs.commonCrawlTimestamp);
  const ssl = pick(inputs.sslFirstSeen);

  const archive = [wayback, crawl].filter(Boolean).sort()[0];

  const candidates: { date: string; weight: number; label: string }[] = [];
  if (release) candidates.push({ date: release, weight: 4, label: "官方发布日" });
  if (github) candidates.push({ date: github, weight: 3.5, label: "GitHub 建仓" });
  if (archive) candidates.push({ date: archive, weight: 2.5, label: "首次网页存档/抓取" });
  if (ssl) candidates.push({ date: ssl, weight: 1, label: "证书首次签发" });

  if (!candidates.length) {
    return { date: null, confidence: "无证据", score: 0, note: "五个来源全部无数据" };
  }

  const primary = [...candidates].sort((a, b) => b.weight - a.weight)[0];
  const agree = candidates.filter((c) => c !== primary && dayDiff(c.date, primary.date) <= 365);
  const score = Math.min(100, Math.round(primary.weight * 18 + agree.length * 6));
  const confidence = score >= 80 ? "高" : score >= 55 ? "中" : "低";

  const chain = candidates.map((c) => `${c.label} ${c.date}`).join("；");
  const note =
    `主证据：${primary.label}（${primary.date}）` +
    (agree.length ? `；一致来源 ${agree.length} 个（±1 年内）` : "；无其他来源相互印证") +
    `。全部证据：${chain}`;

  return { date: primary.date, confidence, score, note };
}