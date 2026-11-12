/**
 * 新采集：按 docs/18-AI工具字段采集方案.md 逐字段采一个网站，验证「方案能不能采全」。
 *
 * 用法：
 *   pnpm exec tsx scripts/field-collect/index.ts --url example.com [--job <后台任务ID>]
 *
 * 设计要点：
 *   1. 与现有采集链路零耦合：不读 content/*.json、不写 aitools、不复用 scripts/fetch 的源封装。
 *      复用封装会把现有逻辑里「某些字段被判定为不可用」的结论带进来，测出来的就不是文档方案了。
 *   2. 每个字段记来源和结局（ok / missing / error）。文档一半字段依赖付费 Actor，
 *      「采不到」本身就是要交付的结论，不能和「没采」混成一个空值。
 *   3. 单源失败不中断整次采集，只影响它负责的字段。
 *   4. 进度写回 D1（field_collect_runs.step），后台和结果页能显示当前在查什么。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { FieldBag, FIELDS, summarize, type FieldResult } from "./fields";
import { loadPricingPage, loadSite, pickPricingUrls, type SiteSnapshot } from "./site";
import { parsePricing } from "./pricing";
import { computeKeywordDensity, parseProfile } from "./text";
import {
  commonCrawlEvidence,
  concludeLaunchDate,
  fetchGithubRepo,
  pickRepoFromLinks,
  sslEvidence,
  waybackEvidence,
} from "./history";
import { fetchLergassy, fetchVortexMode, googleSearch, hasApify, type SerpPage } from "./apify";
import {
  applyLergassy,
  applySerpKeywordFields,
  applySerpReleaseDate,
  applyVortexBase,
  applyVortexSimilarSites,
  normalizeDensity,
  pickOfficialDate,
  pickSampleKeywords,
  textOrUndef,
} from "./mapping";
import { putScreenshot, saveRun } from "./store";
import { arg, loadEnvLocal, normalizeUrl, truncate } from "./util";

export interface SourceReport {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface CollectPayload {
  url: string;
  domain: string;
  requestedAt: string;
  collectedAt: string;
  durationMs: number;
  fields: FieldResult[];
  coverage: ReturnType<typeof summarize>;
  screenshots: { desktop: string | null; mobile: string | null };
  sources: SourceReport[];
  raw: Record<string, unknown>;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function main(): Promise<void> {
  loadEnvLocal();
  const inputUrl = arg("url");
  const jobId = arg("job") || `local-${Date.now()}`;
  const requestedAt = new Date().toISOString();
  const startedAt = Date.now();

  const { url, domain } = normalizeUrl(inputUrl);
  console.log(`[field-collect] job=${jobId} url=${url} domain=${domain}`);

  const fields = new FieldBag();
  const sources: SourceReport[] = [];
  const raw: Record<string, unknown> = {};
  const workDir = path.join(os.tmpdir(), "horizons-field-collect", jobId);
  fs.mkdirSync(workDir, { recursive: true });

  const filledNow = () => FIELDS.filter((f) => fields.has(f.key)).length;

  /** 进度写回；失败只告警 —— 写库失败不该让采集白跑 */
  const markStep = async (step: string) => {
    console.log(`[field-collect] → ${step}`);
    await saveRun({ id: jobId, url, domain, status: "running", step, filled: filledNow(), total: FIELDS.length }).catch(
      (e) => console.warn("[field-collect] 进度写入失败（忽略）：", errMsg(e)),
    );
  };

  /** 单源执行器：失败记进 sources 不抛，返回 null */
  const track = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    const t0 = Date.now();
    try {
      const out = await fn();
      sources.push({ name, ok: true, ms: Date.now() - t0 });
      return out;
    } catch (e) {
      const error = errMsg(e);
      console.warn(`[field-collect] ${name} 失败：${error}`);
      sources.push({ name, ok: false, ms: Date.now() - t0, error });
      return null;
    }
  };

  await markStep("启动浏览器");
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  let snapshot: SiteSnapshot | null = null;
  let desktopShot: string | null = null;
  let mobileShot: string | null = null;

  try {
    /* -------------------- 1. 官网：基础字段 + PC/手机截图 -------------------- */
    await markStep("打开官网并截图（PC / 手机）");
    // 不走 track：loadSite 自己吞异常并以 error 返回，track 会记成 ok:true ，
    // 于是 sources 里会出现同名的一条 ok 加一条 failed，排查时误导得很。
    const siteT0 = Date.now();
    let siteRes: Awaited<ReturnType<typeof loadSite>> | null = null;
    let siteError = "";
    try {
      siteRes = await loadSite(browser, url, { screenshotDir: workDir, domain });
      siteError = siteRes.error ?? "";
    } catch (e) {
      siteError = errMsg(e);
    }
    sources.push({
      name: "目标网站（Playwright）",
      ok: !!siteRes?.snapshot,
      ms: Date.now() - siteT0,
      error: siteRes?.snapshot ? undefined : siteError || "官网无法访问",
    });

    if (siteRes?.snapshot) {
      snapshot = siteRes.snapshot;
      const s = snapshot;

      fields.set("name", s.siteName || s.title || null, { actualSource: "目标网站 og:site_name / title" });
      fields.set("description", truncate(s.description, 400) || null, { actualSource: "目标网站 meta description" });
      fields.set("domain", domain, { actualSource: "URL 解析" });
      fields.set("favicon", s.favicon || `https://www.google.com/s2/favicons?domain=${domain}&sz=64`, {
        actualSource: s.favicon ? "目标网站 link[rel*=icon]" : "Google favicon 服务（页面无 icon 标签）",
      });

      if (s.httpStatus >= 200 && s.httpStatus < 400) {
        fields.setNumber("http_status", s.httpStatus, { actualSource: "首次 HTTP 响应" });
      } else {
        fields.fail("http_status", `HTTP ${s.httpStatus}`);
      }
      if (s.lang) fields.set("language", s.lang, { actualSource: "html[lang]" });
      else fields.missing("language", "html 标签没有 lang 属性");

      // 官网 JSON-LD 里的发布日是最强证据，先占位（SERP 只补空）
      const official = pickOfficialDate(s.publishedDates);
      if (official) {
        fields.set("release_date", official, {
          actualSource: "官网 JSON-LD / meta datePublished",
          note: `原始值：${s.publishedDates.slice(0, 3).join(" | ")}`,
        });
      }

      raw.site = {
        finalUrl: s.finalUrl,
        httpStatus: s.httpStatus,
        title: s.title,
        description: s.description,
        lang: s.lang,
        headings: s.headings.slice(0, 6),
        publishedDates: s.publishedDates.slice(0, 5),
        linkCount: s.links.length,
      };
    } else {
      const error = siteError || "官网无法访问";
      for (const key of ["name", "description", "favicon", "language"]) fields.fail(key, `官网打不开：${error}`);
      fields.fail("http_status", error);
      fields.set("domain", domain, { actualSource: "URL 解析" });
    }

    /* ------------------------------ 截图上传 R2 ------------------------------ */
    await markStep("上传截图到 R2");
    const shots: [string, string | undefined][] = [
      ["desktop", siteRes?.shots.desktop],
      ["mobile", siteRes?.shots.mobile],
    ];
    for (const [kind, file] of shots) {
      if (!file || !fs.existsSync(file)) continue;
      // key 必须平铺：站点 Worker 的 /screenshots/* 只按平铺 key 取图
      const uploaded = await track(`R2 上传（${kind}）`, () =>
        putScreenshot(file, `fieldcollect-${domain}-${kind}.png`),
      );
      if (uploaded) {
        if (kind === "desktop") desktopShot = uploaded;
        else mobileShot = uploaded;
      }
    }

    /* -------------------- 2. 分类 / 核心功能 / 目标用户 -------------------- */
    await markStep("解析 AI 分类 / 核心功能 / 目标用户");
    if (snapshot) {
      const snap = snapshot;
      const profile = await track("DeepSeek 字段抽取", () =>
        parseProfile({
          title: snap.siteName || snap.title,
          description: snap.description,
          headings: snap.headings,
          text: snap.text,
        }),
      );
      if (profile) {
        const src = profile.source === "deepseek" ? "DeepSeek（deepseek-chat）" : "关键词规则（无 LLM）";
        fields.set("category", profile.category, { actualSource: src, note: profile.note });
        fields.set("features", profile.features, { actualSource: src, note: profile.note });
        fields.set("target_audience", profile.targetAudience, { actualSource: src, note: profile.note });
        raw.profile = profile;
      }
    } else {
      for (const key of ["category", "features", "target_audience"]) fields.missing(key, "官网打不开，无法解析内容");
    }

    /* ------------------------------ 3. 定价页 ------------------------------ */
    await markStep("抓取定价页并解析");
    if (snapshot) {
      const snap = snapshot;
      const pricingUrls = pickPricingUrls(snap, domain);
      const page = await track("定价页抓取", () => loadPricingPage(browser, pricingUrls));
      if (page && page.text.trim()) {
        const parsed = parsePricing(page.text, page.url);
        const src = `Pricing 页 ${page.url}`;
        fields.set("pricing_model", parsed.model, { actualSource: src, note: parsed.note });
        fields.set("has_free_plan", parsed.hasFreePlan === true, {
          display: parsed.hasFreePlan === true ? "是" : "否",
          actualSource: src,
          note: parsed.hasFreePlan === true ? undefined : "定价页正文未出现 Free 套餐",
        });
        fields.set("has_free_trial", parsed.hasFreeTrial === true, {
          display: parsed.hasFreeTrial === true ? "是" : "否",
          actualSource: src,
          note: parsed.hasFreeTrial === true ? undefined : "定价页正文未出现 trial 字样",
        });
        fields.setNumber("starting_price", parsed.startingPrice, {
          actualSource: src,
          note: parsed.samples.length ? `页面价格样本：${parsed.samples.join(" / ")}` : parsed.note,
        });
        fields.set("currency", parsed.currency, { actualSource: src });
        raw.pricing = { url: page.url, parsed };
      } else {
        const why = page?.error ?? "未找到定价页";
        for (const key of ["pricing_model", "has_free_plan", "has_free_trial", "starting_price", "currency"]) {
          fields.fail(key, `定价页抓取失败：${why}`);
        }
      }

      fields.set("has_api", snap.apiHint, {
        display: snap.apiHint ? "是" : "否",
        actualSource: "官网链接与文案识别",
        note: snap.apiHint ? undefined : "首页未出现 api/docs/developer 相关链接",
      });
    } else {
      for (const key of ["pricing_model", "has_free_plan", "has_free_trial", "starting_price", "currency", "has_api"]) {
        fields.missing(key, "官网打不开");
      }
    }

    /* ---------------------------- 4. GitHub 仓库 ---------------------------- */
    await markStep("识别 GitHub 仓库并取指标");
    const repoName = snapshot ? pickRepoFromLinks(snapshot.links) : null;
    if (repoName) {
      const repo = await track("GitHub REST API", () => fetchGithubRepo(repoName));
      if (repo && !repo.error) {
        fields.set("github_repo", repo.htmlUrl, { actualSource: "GitHub REST API" });
        fields.set("has_open_source", true, { display: "是", actualSource: "官网链接识别 + GitHub API" });
        fields.setNumber("github_stars", repo.stars, { actualSource: "GitHub REST API" });
        fields.setNumber("github_forks", repo.forks, { actualSource: "GitHub REST API" });
        fields.set("github_pushed_at", repo.pushedAt ?? null, { actualSource: "GitHub REST API" });
        fields.set("github_created_at", repo.createdAt ?? null, { actualSource: "GitHub REST API" });
        raw.github = repo;
      } else {
        const error = repo?.error ?? "GitHub API 无返回";
        for (const key of ["github_stars", "github_forks", "github_pushed_at", "github_created_at"]) {
          fields.fail(key, error);
        }
        fields.set("github_repo", `https://github.com/${repoName}`, { actualSource: "官网链接识别" });
        fields.set("has_open_source", true, { display: "是", actualSource: "官网链接识别" });
      }
    } else if (snapshot) {
      // 找不到仓库链接不等于闭源，填「否」但把依据写清楚
      fields.set("has_open_source", false, {
        display: "否",
        actualSource: "官网链接识别",
        note: "首页未发现 github.com 仓库链接（可能开源但未链接）",
      });
      for (const key of ["github_repo", "github_stars", "github_forks", "github_pushed_at", "github_created_at"]) {
        fields.missing(key, "首页未发现 GitHub 仓库链接");
      }
    } else {
      // 官网没打开：连首页链接都没拿到，断言「不开源」是错的结论
      for (const key of ["has_open_source", "github_repo", "github_stars", "github_forks", "github_pushed_at", "github_created_at"]) {
        fields.missing(key, "官网打不开，无法识别是否开源 / 仓库链接");
      }
    }

    /* ------------------------- 5. 上线时间证据链 ------------------------- */
    await markStep("查询上线时间证据（Wayback / Common Crawl / CT 日志）");
    const [wayback, crawl, ssl] = await Promise.all([
      track("Wayback CDX", () => waybackEvidence(domain)),
      track("Common Crawl Index", () => commonCrawlEvidence(domain)),
      track("证书透明度日志", () => sslEvidence(domain)),
    ]);

    if (wayback?.timestamp) {
      fields.set("wayback_first_timestamp", wayback.timestamp, { actualSource: "Wayback CDX" });
      fields.set("wayback_first_url", wayback.url ?? null, { actualSource: "Wayback CDX" });
      fields.set("wayback_first_status", wayback.okStatuscode ?? wayback.statuscode ?? null, {
        actualSource: "Wayback CDX",
        note: wayback.okTimestamp ? `首个 200 快照：${wayback.okTimestamp}` : "取最早快照的 HTTP 状态",
      });
    } else {
      for (const key of ["wayback_first_timestamp", "wayback_first_url", "wayback_first_status"]) {
        fields.missing(key, wayback?.error ?? "无存档记录");
      }
    }

    if (crawl?.timestamp) {
      fields.set("commoncrawl_first_timestamp", crawl.timestamp, {
        actualSource: "Common Crawl Index",
        note: crawl.crawl ? `首次出现在 ${crawl.crawl}` : undefined,
      });
    } else {
      fields.missing("commoncrawl_first_timestamp", crawl?.error ?? "无抓取记录");
    }

    if (ssl?.notBefore) {
      fields.set("ssl_first_seen", ssl.notBefore, {
        actualSource: ssl.source === "crt.live" ? "crt.live API" : "crt.sh（crt.live 无公开 JSON 接口）",
        note: ssl.issuer ? `签发者：${ssl.issuer}` : undefined,
      });
    } else {
      fields.missing("ssl_first_seen", ssl?.error ?? "无证书记录");
    }
    raw.launchEvidence = { wayback, crawl, ssl };

    /* ------------------ 6. Similarweb（三种模式 + 备选源） ------------------ */
    const sampleKeywords: string[] = [];
    if (!hasApify()) {
      await markStep("未配置 APIFY_TOKEN，跳过 Similarweb / SERP");
      sources.push({ name: "Apify", ok: false, ms: 0, error: "未配置 APIFY_TOKEN" });
    } else {
      await markStep("Similarweb：base_data / similar_sites / aitdk 三种模式");
      const [base, similar, aitdk] = await Promise.all([
        track("Similarweb base_data", () => fetchVortexMode(domain, "base_data")),
        track("Similarweb similar_sites", () => fetchVortexMode(domain, "similar_sites")),
        track("Similarweb aitdk", () => fetchVortexMode(domain, "aitdk")),
      ]);

      if (base?.item) {
        applyVortexBase(fields, base.item, "Similarweb base_data（vortex）");
        raw.similarwebBase = base.item;
      } else if (base?.error) {
        sources.push({ name: "Similarweb base_data 明细", ok: false, ms: 0, error: base.error });
      }

      if (aitdk?.item) {
        const dens = normalizeDensity(aitdk.item);
        if (dens.items.length) {
          fields.set("keyword_density", dens.items, {
            display: dens.items.slice(0, 8).map((d) => `${d.term} ${d.density}%`).join("；"),
            actualSource: "Similarweb aitdk（vortex）",
          });
        }
        if (dens.totalWords) {
          fields.setNumber("keyword_density_total_words", dens.totalWords, {
            actualSource: "Similarweb aitdk（vortex）",
          });
        }
        raw.aitdk = aitdk.item;
      } else if (aitdk?.error) {
        sources.push({ name: "Similarweb aitdk 明细", ok: false, ms: 0, error: aitdk.error });
      }

      if (similar?.item) {
        applyVortexSimilarSites(fields, similar.item, "Similarweb similar_sites（vortex）");
        raw.similarSites = similar.item;
      } else if (similar?.error) {
        sources.push({ name: "Similarweb similar_sites 明细", ok: false, ms: 0, error: similar.error });
      }

      await markStep("备选源 lergassy Similarweb（补空字段）");
      const fallback = await track("lergassy Similarweb", () => fetchLergassy(domain));
      if (fallback?.item) {
        applyLergassy(fields, fallback.item);
        raw.lergassy = fallback.item;
      } else if (fallback?.error) {
        sources.push({ name: "lergassy 明细", ok: false, ms: 0, error: fallback.error });
      }
    }

    /* ---------------------- 7. 关键词密度（本地兜底） ---------------------- */
    if (!fields.has("keyword_density") && snapshot) {
      const dens = computeKeywordDensity(snapshot.text);
      if (dens.items.length) {
        fields.set("keyword_density", dens.items, {
          display: dens.items.slice(0, 8).map((d) => `${d.term} ${d.density}%`).join("；"),
          actualSource: "本地分词（首页正文，替代 AITDK）",
          note: "aitdk 模式无数据，按英文单词 + 中文 2-gram 本地统计，口径与 Similarweb 不完全一致",
        });
      }
      if (dens.totalWords) {
        fields.setNumber("keyword_density_total_words", dens.totalWords, { actualSource: "本地分词（首页正文）" });
      }
      raw.keywordDensity = dens;
    }

    /* --------------------------- 8. Google SERP --------------------------- */
    await markStep("Google 搜索（关键词排名 / 发布日）");
    sampleKeywords.push(...pickSampleKeywords(fields, 3));
    const launchQuery = `${snapshot?.siteName || snapshot?.title || domain} launch date`;
    const queries = [...sampleKeywords, launchQuery].filter((q) => q && q.trim());

    if (hasApify() && queries.length) {
      const serp = await track("Google Search Scraper", () => googleSearch(queries, { countryCode: "us" }));
      const pages: SerpPage[] = serp?.pages ?? [];
      if (pages.length) {
        raw.serp = pages.map((p) => ({
          query: typeof p.searchQuery === "string" ? p.searchQuery : (p.searchQuery?.term ?? ""),
          results: (p.organicResults ?? []).slice(0, 5).map((r) => ({ position: r.position, url: r.url, date: r.date })),
        }));
        applySerpKeywordFields(fields, pages, domain);
        // 官网 JSON-LD 已经给出发布日时不再用 SERP 覆盖
        if (!fields.has("release_date")) applySerpReleaseDate(fields, pages, launchQuery, domain);
      } else if (serp?.error) {
        sources.push({ name: "Google Search 明细", ok: false, ms: 0, error: serp.error });
      }
    } else if (!hasApify()) {
      for (const key of ["keyword_rank", "serp_title", "serp_url", "top10_count", "top20_count", "release_date"]) {
        fields.missing(key, "未配置 APIFY_TOKEN");
      }
    }

    /* ------------------------- 9. 上线日期推算 ------------------------- */
    await markStep("推算上线日期与可信度");
    const launch = concludeLaunchDate({
      releaseDate: textOrUndef(fields.get("release_date")),
      githubCreatedAt: textOrUndef(fields.get("github_created_at")),
      waybackTimestamp: textOrUndef(fields.get("wayback_first_timestamp")),
      commonCrawlTimestamp: textOrUndef(fields.get("commoncrawl_first_timestamp")),
      sslFirstSeen: textOrUndef(fields.get("ssl_first_seen")),
    });
    fields.set("launch_date", launch.date, { actualSource: "多来源综合推算", note: launch.note });
    fields.set("launch_confidence", launch.confidence, {
      display: `${launch.confidence}（${launch.score}/100）`,
      actualSource: "多来源综合推算",
      note: launch.note,
    });
    raw.launch = launch;

    /* ---------------------------- 10. 汇总落库 ---------------------------- */
    await markStep("汇总写入结果");
    const results = fields.toResults();
    const coverage = summarize(results);
    const payload: CollectPayload = {
      url,
      domain,
      requestedAt,
      collectedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      fields: results,
      coverage,
      screenshots: { desktop: desktopShot, mobile: mobileShot },
      sources,
      raw,
    };

    await saveRun({
      id: jobId,
      url,
      domain,
      status: "success",
      step: "采集完成",
      filled: coverage.filled,
      total: coverage.total,
      desktopUrl: desktopShot,
      mobileUrl: mobileShot,
      result: payload,
    });

    // 本地跑时也落一份文件，方便直接 diff 字段
    const outFile = path.join(workDir, "result.json");
    fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));

    console.log(`[field-collect] 完成 ${coverage.filled}/${coverage.total}（缺失 ${coverage.missing}，失败 ${coverage.error}）`);
    for (const g of coverage.groups) console.log(`  ${g.name}: ${g.filled}/${g.total}`);
    console.log(`[field-collect] 结果文件：${outFile}`);
    if (coverage.groups.some((g) => g.filled === 0)) {
      const empty = coverage.groups.filter((g) => g.filled === 0).map((g) => g.name);
      console.warn(`[field-collect] 注意：以下分组一个字段都没采到 —— ${empty.join("、")}`);
    }
  } catch (e) {
    await failRun(jobId, url, domain, fields, sources, raw, requestedAt, startedAt, errMsg(e), desktopShot, mobileShot);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * 异常中断时的收尾。
 *
 * 已经采到的字段照样写库（status=failure + error），而不是留一个空行：
 * 「采到 40 个字段之后崩了」和「一个字段没采到」对定位问题是两件事。
 */
async function failRun(
  jobId: string,
  url: string,
  domain: string,
  fields: FieldBag,
  sources: SourceReport[],
  raw: Record<string, unknown>,
  requestedAt: string,
  startedAt: number,
  message: string,
  desktopShot: string | null,
  mobileShot: string | null,
): Promise<void> {
  console.error("[field-collect] 采集失败：", message);
  const results = fields.toResults();
  const coverage = summarize(results);
  await saveRun({
    id: jobId,
    url,
    domain,
    status: "failure",
    step: "采集中断",
    filled: coverage.filled,
    total: coverage.total,
    desktopUrl: desktopShot,
    mobileUrl: mobileShot,
    result: {
      url,
      domain,
      requestedAt,
      collectedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      fields: results,
      coverage,
      screenshots: { desktop: desktopShot, mobile: mobileShot },
      sources,
      raw,
    } satisfies CollectPayload,
    error: message,
  }).catch((e) => console.error("[field-collect] 失败结果也写不进去：", errMsg(e)));
}

main().catch((e) => {
  // normalizeUrl 阶段就挂了（比如输入不是网址）时走这里：没有 jobId 可写，直接失败退出
  console.error("[field-collect] 启动失败：", errMsg(e));
  process.exitCode = 1;
});