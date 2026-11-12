/**
 * 英文简介 → 中文一句话描述。
 *
 * 为什么要单独一层：
 *   采集端（PH/HN/Futurepedia）拿到的 tagline 全是英文，写进 D1 候选池后
 *   后台列表直接展示，人看到的就是英文。以前只有「富化」阶段（enrich-site.ts）
 *   才会产出 descriptionZh，而富化要人工确认收录后才触发，中间这段全是英文。
 *
 * 判定口径统一用「描述里有没有中文字符」，不看 descriptionSource ——
 * 历史上被误标成 ai 却仍是英文的条目也能被捞出来重翻。
 */
import { chatJSON, hasLLM } from "./sources/llm";

export const ZH_RE = /[\u4e00-\u9fa5]/;

/** 只翻译简介，不动分类与赛道，避免机器重判覆盖已校准的品类 */
export const SYSTEM_DESC = `你是 AI 工具目录的中文编辑。用户给出若干工具的名称与英文简介。
把每条英文简介翻译成中文，要求：
- 不超过 40 字，说清「做什么」和「给谁用」；
- 产品名 / 品牌名保持原文，不翻译；
- 不要「该工具」「这是一款」这类冗余开头，直接说功能；
- API、SaaS、LLM 等专业术语保留原文，不硬译；
- 语气客观，不夸大（不写「最强」「颠覆」）。
输出 JSON：{"items":[{"id":<原样返回的 id>,"zh":"<中文简介>"}]}，条数与输入一致，不要多余文本。`;

export interface Translatable {
  name: string;
  description?: string;
  /** ai = 已由模型译/写过；source = 采集原文 */
  descriptionSource?: string;
}

export interface ZhStats {
  /** 本次真的翻成中文的条数 */
  translated: number;
  /** 需要翻译但请求失败的条数 */
  failed: number;
  /** 本来就是中文 / 没有描述，未参与 */
  skipped: number;
}

const BATCH = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 需要翻译的：有描述且不含中文 */
export function needsZh(item: Translatable): boolean {
  return Boolean(item.description && !ZH_RE.test(item.description));
}

/**
 * 原地把 items 里的英文描述翻成中文，返回统计。
 *
 * 失败不抛错：采集流程里宁可留几条英文，也不能因为 LLM 抖动整批入库失败。
 * 调用方负责在日志里体现 translated/failed，人看到数字不对再去重跑。
 */
export async function translateInPlace(
  items: readonly Translatable[],
  log: (msg: string) => void = (m) => console.log(m),
): Promise<ZhStats> {
  const stats: ZhStats = { translated: 0, failed: 0, skipped: 0 };
  const targets = items.filter(needsZh);
  stats.skipped = items.length - targets.length;

  if (targets.length === 0) {
    log("[zh] 描述已全部是中文，跳过翻译");
    return stats;
  }
  if (!hasLLM()) {
    log(
      `::warning::[zh] 未配置 DEEPSEEK_API_KEY，${targets.length} 条描述保持英文（后台会显示原文）`,
    );
    stats.failed = targets.length;
    return stats;
  }

  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    const input = JSON.stringify(
      chunk.map((t, idx) => ({ id: idx, name: t.name, tagline: t.description })),
    );
    try {
      const out = await chatJSON<{ items?: Array<{ id?: number; zh?: string }> }>(
        SYSTEM_DESC,
        input,
      );
      for (const row of out.items ?? []) {
        const target = typeof row.id === "number" ? chunk[row.id] : undefined;
        const zh = row.zh?.trim();
        // 模型原样返回英文的情况不少，必须真的含中文才算数
        if (!target || !zh || !ZH_RE.test(zh)) continue;
        target.description = zh.slice(0, 60);
        // 标成 ai：否则下游（enrich-llm 增量、发布校验）仍当它是采集原文
        target.descriptionSource = "ai";
        stats.translated++;
      }
    } catch (e) {
      stats.failed += chunk.length;
      log(
        `::warning::[zh] 批次 ${Math.floor(i / BATCH) + 1} 翻译失败：${
          e instanceof Error ? e.message.slice(0, 120) : String(e)
        }`,
      );
    }
    if (i + BATCH < targets.length) await sleep(200);
  }

  return stats;
}