/**
 * D1 写入客户端（GitHub Actions 与本地脚本共用）。
 *
 * 两条通道，按凭据自动选择：
 *
 * 1. **REST**（默认，CI 用）：`POST /accounts/{id}/d1/database/{db}/query`，
 *    只需要 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`，支持 `batch` 原子提交。
 * 2. **wrangler CLI**（本地用）：没有 API token、但本机已 `wrangler login` 时，
 *    复用 OAuth 登录态执行。不需要任何密钥，代价是每条语句起一个子进程、
 *    且 `--file` 多语句**不是原子的**（失败不会整体回滚）。
 *
 * 所以：本地验证用 CLI 通道，正式发布走 REST 通道。两者 SQL 完全一致。
 *
 * 四个设计决定：
 *
 * 1. **不提供事务** —— D1 的 REST 端点没有交互式事务，`BEGIN` 也不被支持。
 *    我们的一致性不靠事务，靠「版本指针最后切换」：半成品写在旧版本之后，
 *    读者看不见，重跑时 UPSERT 覆盖掉。
 * 2. **顺序执行，不并发** —— 同一张表的并发写入只会互相等锁，
 *    还会让限流更容易触发。慢一点换稳定，值得。
 * 3. **429 / 5xx 指数退避** —— Cloudflare API 限流是常态，不是故障。
 * 4. **多条语句走 batch** —— 一次发布有 400+ 条语句，逐条发就是 400+ 次
 *    HTTP 往返，既慢又容易撞限流。`batch` 把它们压成十几次请求，
 *    且服务端对整批原子执行。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const API_BASE = "https://api.cloudflare.com/client/v4";

/** 库 ID 与库名都不是机密，写死省一个 Secret；仍允许环境变量覆盖 */
const DEFAULT_DATABASE_ID = "355e5cca-29ca-4b37-90a5-6c88d94e7a4b";
const DEFAULT_DATABASE_NAME = "horizons-db";

const MAX_ATTEMPTS = 5;

/** 单次 batch 请求最多带多少条语句（控制请求体大小与失败重试粒度） */
const BATCH_STATEMENTS = 50;

/** 单次 batch 请求体的字节上限 */
const BATCH_REQUEST_BYTES = 2 * 1024 * 1024;

/**
 * CLI 通道单次 `--command` 的字节上限。
 *
 * 比 REST 小得多：SQL 要整个塞进 argv，macOS 的 ARG_MAX 是 1MB，
 * 还要留给环境变量和其他参数。实测 `--file` 上传在当前网络下会
 * `fetch failed`，所以 CLI 通道统一走 `--command`。
 */
const CLI_COMMAND_BYTES = 100 * 1024;

/**
 * CLI 通道单条语句的字节上限。
 *
 * D1 硬限制是 100KB/语句，留两成余量给模板文本和转义后的引号。
 * 超过就 `statement too long: SQLITE_TOOBIG`，报错里不含表名，很难定位。
 */
const CLI_STATEMENT_BYTES = 80 * 1024;

export interface D1QueryResult<T = Record<string, unknown>> {
  results: T[];
  /** affected rows，UPSERT 命中时也计入 */
  changes: number;
  rowsRead: number;
  rowsWritten: number;
}

export interface D1Statement {
  sql: string;
  params?: readonly unknown[];
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: Array<{
    success: boolean;
    results?: T[];
    meta?: { changes?: number; rows_read?: number; rows_written?: number };
  }>;
}

export interface D1Client {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<D1QueryResult<T>>;
  /** 顺序执行多条语句，任一条失败即抛错 */
  run(stmts: readonly D1Statement[]): Promise<void>;
  /** 批量提交：多条语句合并成一次请求 */
  batch(stmts: readonly D1Statement[]): Promise<void>;
  /**
   * 单条 INSERT 能带多少字节的行数据。
   *
   * REST 通道的参数是绑定的，SQL 文本只有 `VALUES (?,?),…`，几十字节，
   * 值多大都不影响语句长度 —— 所以这里可以放到请求体上限。
   *
   * CLI 通道要把值内联进 SQL，而 D1 单条语句上限 100KB，
   * 内联后立刻撞 `SQLITE_TOOBIG`。所以调用方必须按这个值分块。
   */
  readonly statementByteLimit: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const encoder = new TextEncoder();

/** 当前可用通道：有 API token 走 REST，否则看 wrangler 是否已登录 */
export type D1Transport = "rest" | "wrangler" | null;

export function d1Transport(): D1Transport {
  if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) return "rest";
  return wranglerAvailable() ? "wrangler" : null;
}

/** 凭据是否可用（任一通道）。缺了让调用方决定跳过还是报错，不在这里静默降级 */
export function d1Configured(): boolean {
  return d1Transport() !== null;
}

/**
 * wrangler 是否已登录。
 *
 * 只看凭据文件是否存在，不跑 `wrangler whoami` —— 那要起进程、走网络，
 * 而这段代码在每次脚本启动时都会执行。真登录失效时 CLI 通道会报出
 * wrangler 自己的错误信息，比这里猜一个更准。
 */
let wranglerChecked: boolean | null = null;
function wranglerAvailable(): boolean {
  if (wranglerChecked !== null) return wranglerChecked;
  const home = os.homedir();
  const candidates = [
    // macOS / Linux
    path.join(home, "Library/Preferences/.wrangler/config/default.toml"),
    path.join(home, ".wrangler/config/default.toml"),
    // 新版 wrangler 的 XDG 目录
    path.join(home, ".config/.wrangler/config/default.toml"),
  ];
  if (process.env.WRANGLER_HOME) {
    candidates.unshift(path.join(process.env.WRANGLER_HOME, "config/default.toml"));
  }
  wranglerChecked = candidates.some((p) => fs.existsSync(p));
  return wranglerChecked;
}

/**
 * 把语句按「条数 + 字节」切分成若干批。
 *
 * batch 请求体同样会撞上限：详情批每批 25 行 × 20KB 就是 500KB，
 * 50 条摞一起是 25MB —— 所以条数和字节要同时看。
 */
function splitStatements(
  stmts: readonly D1Statement[],
  maxBytes = BATCH_REQUEST_BYTES,
): D1Statement[][] {
  const out: D1Statement[][] = [];
  let cur: D1Statement[] = [];
  let bytes = 0;

  for (const s of stmts) {
    const size = encoder.encode(JSON.stringify(s)).length;
    if (cur.length >= BATCH_STATEMENTS || (cur.length > 0 && bytes + size > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(s);
    bytes += size;
  }

  if (cur.length > 0) out.push(cur);
  return out;
}

/* ------------------------------ REST 通道 ------------------------------ */

function createRestClient(token: string, accountId: string): D1Client {
  const databaseId = process.env.D1_DATABASE_ID || DEFAULT_DATABASE_ID;
  const url = `${API_BASE}/accounts/${accountId}/d1/database/${databaseId}/query`;

  /** 发一次请求，带 429 / 5xx / 网络失败退避。payload 必须是幂等的 */
  async function post<T>(payload: unknown, attempt = 1): Promise<CfEnvelope<T>> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      if (attempt < MAX_ATTEMPTS) {
        await sleep(1000 * attempt);
        return post<T>(payload, attempt + 1);
      }
      throw new Error(`D1 请求失败（网络）：${String(e)}`);
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt < MAX_ATTEMPTS) {
        await sleep(2000 * attempt);
        return post<T>(payload, attempt + 1);
      }
      throw new Error(`D1 请求失败（${res.status}），已重试 ${MAX_ATTEMPTS} 次`);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`D1 HTTP ${res.status}：${body.slice(0, 500)}`);
    }

    const body = (await res.json()) as CfEnvelope<T>;
    if (!body.success) {
      const msg = (body.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ");
      throw new Error(`D1 执行失败：${msg || "unknown"}`);
    }
    return body;
  }

  async function query<T>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<D1QueryResult<T>> {
    let body: CfEnvelope<T>;
    try {
      body = await post<T>({ sql, params });
    } catch (e) {
      // 带上 SQL 片段：400+ 条语句里出问题，没有上下文根本定位不到
      throw new Error(`${String(e)}\nSQL: ${sql.slice(0, 300)}`);
    }

    const first = body.result?.[0];
    return {
      results: first?.results ?? [],
      changes: first?.meta?.changes ?? 0,
      rowsRead: first?.meta?.rows_read ?? 0,
      rowsWritten: first?.meta?.rows_written ?? 0,
    };
  }

  async function batch(stmts: readonly D1Statement[]): Promise<void> {
    if (stmts.length === 0) return;

    for (const part of splitStatements(stmts)) {
      const payload = {
        batch: part.map((s) => ({ sql: s.sql, params: s.params ?? [] })),
      };

      let body: CfEnvelope<unknown>;
      try {
        body = await post<unknown>(payload);
      } catch (e) {
        throw new Error(`${String(e)}\n首批语句: ${part[0]?.sql.slice(0, 200) ?? ""}`);
      }

      // 整批里任一条失败，服务端会回滚，但 HTTP 仍是 200 —— 必须逐条看
      const failedAt = body.result?.findIndex((r) => r.success === false) ?? -1;
      if (failedAt >= 0) {
        throw new Error(
          `D1 batch 第 ${failedAt + 1} 条语句失败，整批已回滚：` +
            `${part[failedAt]?.sql.slice(0, 200) ?? ""}`,
        );
      }
    }
  }

  return { query, batch, run: batch, statementByteLimit: BATCH_REQUEST_BYTES };
}

/* ------------------------------ wrangler 通道 ------------------------------ */

/**
 * 把一个 JS 值转成 SQL 字面量。
 *
 * CLI 通道没有绑定参数，只能内联。这里只允许标量与 null：
 * 出现对象说明上游把应该 JSON.stringify 的字段直接传了进来，直接报错，
 * 而不是拼出一个 `[object Object]` 写进库。
 */
function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "string") {
    if (v.includes("\u0000")) throw new Error("D1 文本不支持 NUL 字节，写入前需剔除");
    return `'${v.replace(/'/g, "''")}'`;
  }
  throw new Error(`不支持内联的参数类型：${typeof v}（应为字符串/数字/布尔/null）`);
}

/** 按顺序替换 `?` 占位符。我们的 SQL 全由模板生成，字面量里不含 `?` */
function inlineParams(sql: string, params: readonly unknown[]): string {
  let i = 0;
  const out = sql.replace(/\?/g, () => sqlLiteral(params[i++]));
  if (i !== params.length) {
    throw new Error(`参数个数不匹配：SQL 有 ${i} 个占位符，传了 ${params.length} 个`);
  }
  return out;
}

function runWrangler(args: string[]): string {
  try {
    return execFileSync(
      "pnpm",
      ["--filter", "@horizons/api", "exec", "wrangler", "d1", ...args],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const detail = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim();
    throw new Error(`wrangler 执行失败：${detail.slice(-800) || err.message}`);
  }
}

/** wrangler 的 JSON 输出前面可能带日志行，从第一个 `[` 起解析 */
function parseWranglerJson(out: string): Array<Record<string, unknown>> {
  const start = out.indexOf("[");
  if (start < 0) throw new Error(`wrangler 输出里找不到 JSON：${out.slice(0, 300)}`);
  return JSON.parse(out.slice(start)) as Array<Record<string, unknown>>;
}

function createWranglerClient(): D1Client {
  const dbName = process.env.D1_DATABASE_NAME || DEFAULT_DATABASE_NAME;

  async function query<T>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<D1QueryResult<T>> {
    let rows: Array<Record<string, unknown>>;
    try {
      /*
       * 查询是只读的，抖动重试绝对安全。之前只有 batch 带重试，
       * 结果全量还原跑到一半会因为一次 7403 / fetch failed 整个中断。
       */
      let lastError: unknown;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          rows = parseWranglerJson(
            runWrangler([
              "execute",
              dbName,
              "--remote",
              "--json",
              "--command",
              inlineParams(sql, params),
            ]),
          );
          lastError = undefined;
          break;
        } catch (e) {
          lastError = e;
          if (attempt < MAX_ATTEMPTS) await sleep(1500 * attempt);
        }
      }
      if (lastError) throw lastError;
    } catch (e) {
      throw new Error(`${String(e)}\nSQL: ${sql.slice(0, 300)}`);
    }

    const first = rows[0] as
      | { results?: T[]; success?: boolean; meta?: { changes?: number; rows_read?: number; rows_written?: number } }
      | undefined;
    if (first?.success === false) {
      throw new Error(`D1 执行失败：${JSON.stringify(rows).slice(0, 500)}`);
    }
    return {
      results: first?.results ?? [],
      changes: first?.meta?.changes ?? 0,
      rowsRead: first?.meta?.rows_read ?? 0,
      rowsWritten: first?.meta?.rows_written ?? 0,
    };
  }

  async function batch(stmts: readonly D1Statement[]): Promise<void> {
    if (stmts.length === 0) return;

    /*
     * 用 `--command` 而不是 `--file`：实测 `--file` 走的是另一条上传路径，
     * 在当前网络下稳定 `fetch failed`；`--command` 一次多条用分号分隔即可，
     * 稳定可用。代价是 SQL 要整个塞进 argv，所以按 200KB 切，比 REST 保守。
     *
     * 注意：多语句在 D1 里**不是原子执行**，中途失败时前面的语句已经生效。
     * 这是本地验证通道的固有代价 —— 失败后用同一个版本号重跑即可，
     * UPSERT 会覆盖，不会产生重复行。
     */
    for (const part of splitStatements(stmts, CLI_COMMAND_BYTES)) {
      const sql = part.map((s) => `${inlineParams(s.sql, s.params ?? [])};`).join("\n");
      const size = encoder.encode(sql).length;
      if (size > CLI_COMMAND_BYTES * 4) {
        throw new Error(
          `单批 SQL 约 ${Math.round(size / 1024)}KB，超过命令行长度上限。` +
            `本地验证通道只适合中小批量；正式发布请配置 CLOUDFLARE_API_TOKEN 走 REST 通道。`,
        );
      }
      /*
       * 本地网络抖动很常见（wrangler 报 `A fetch request failed`），
       * 而这一批是幂等的 UPSERT，重试安全。REST 通道有 429/5xx 退避，
       * 这里补上同等处理，否则一次抖动就中断整个发布。
       */
      let lastError: unknown;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          runWrangler(["execute", dbName, "--remote", "--command", sql]);
          lastError = undefined;
          break;
        } catch (e) {
          lastError = e;
          if (attempt < MAX_ATTEMPTS) await sleep(1500 * attempt);
        }
      }
      if (lastError) {
        throw new Error(
          `${String(lastError)}\n批次首条语句: ${part[0]?.sql.slice(0, 200) ?? ""}`,
        );
      }
    }
  }

  return { query, batch, run: batch, statementByteLimit: CLI_STATEMENT_BYTES };
}

export function createD1Client(): D1Client {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  if (token && accountId) return createRestClient(token, accountId);

  if (wranglerAvailable()) {
    console.log("[d1] 未配置 API token，改用本机 wrangler 登录态（本地验证通道）");
    return createWranglerClient();
  }

  throw new Error(
    "无法写入 D1：既没有 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID，本机也没有 wrangler 登录态。\n" +
      "任一即可：`pnpm wrangler login`，或在 .env.local 里补上这两个变量；只想验算则加 --no-d1。",
  );
}