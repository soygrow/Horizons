/**
 * 导出 Product Hunt 全量 topic → apps/site/public/data/ph-topics.json。
 *
 * 后台「获取新工具」的 Topic 输入框要能检索。PH 对不存在的 slug 是**静默**返回空
 * （写成 agent 时日志就是「翻 0 页扫 0 条，产出 0」），让运营手敲 slug 迟早再踩一次。
 *
 * 为什么落静态文件而不是每次输入都查 PH：
 *   · PH 全站只有 400 多个 topic（实测 434），过滤掉僵尸的还剩 429 个，JSON 约 30KB；
 *   · topics(query:) 是**子串**匹配，质量很差 —— 搜 ai 会返回 Fundraising（fundr**ai**sing）、
 *     Pitch Dubai（dub**ai**），搜 agent 直接 0 条。放本地才能自己定排序：前缀优先 + 热度。
 *   · 前端每次检索都带 token 打 PH，既要下发凭据又会被限流，毫无必要。
 *
 * topic 集合变动极慢，隔几个月手动跑一次即可；新增 topic 忘更新时仍可手填 slug，
 * 采集端会校验并在回退时提示。
 *
 * 用法：pnpm tsx scripts/admin/dump-ph-topics.ts
 */
import fs from "node:fs";
import path from "node:path";
import { config, getProductHuntToken } from "../fetch/config";

const PH_GRAPHQL = "https://api.producthunt.com/v2/api/graphql";
/*
 * 故意不放 public/data/：那里全是 pnpm data 每次重算的产物（已 gitignore），
 * 而这份清单很少变、又必须在构建后就存在（线上没有 PH token，也无法实时拉），
 * 所以入库跟着代码走。真变了手动重跑一次本脚本。
 */
const OUT = "apps/site/public/ph-topics.json";

interface PhTopic {
  slug: string;
  name: string;
  followers: number;
  posts: number;
}

/** 与 productHunt.ts 的取 token 顺序一致：先本地 .ph-token.json，再环境变量 */
function getToken(): string | null {
  try {
    const p = path.resolve(process.cwd(), ".ph-token.json");
    const data = JSON.parse(fs.readFileSync(p, "utf-8")) as { access_token?: string };
    if (data.access_token) return data.access_token;
  } catch {
    // 忽略，回退 Developer Token
  }
  return getProductHuntToken();
}

/** PH 免费额度按小时算，连翻十几页很容易吃到 429：退避后重试，别让半份清单写文件 */
async function gql<T>(token: string, query: string, attempt = 0): Promise<T> {
  const res = await fetch(PH_GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": config.userAgent,
    },
    body: JSON.stringify({ query }),
  });
  if (res.status === 429 && attempt < 4) {
    const wait = 3000 * 2 ** attempt;
    console.warn(`[ph-topics] 被限流（429），${wait / 1000}s 后重试（${attempt + 1}/4）`);
    await new Promise((r) => setTimeout(r, wait));
    return gql<T>(token, query, attempt + 1);
  }
  if (!res.ok) throw new Error(`Product Hunt 请求失败：${res.status}`);
  const data = (await res.json()) as { data?: T; errors?: Array<{ message?: string }> };
  if (data.errors?.length) {
    throw new Error(`Product Hunt 返回错误：${data.errors[0]?.message ?? "未知错误"}`);
  }
  if (!data.data) throw new Error("Product Hunt 没有返回 data");
  return data.data;
}

interface TopicsPage {
  topics: {
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
    edges: Array<{ node: PhTopic }>;
  };
}

async function main(): Promise<void> {
  const token = getToken();
  if (!token) throw new Error("未配置 PH 凭据（.ph-token.json 或 PH_TOKEN）");

  const all: PhTopic[] = [];
  let after: string | null = null;
  for (let page = 0; page < 40; page++) {
    const data = await gql<TopicsPage>(
      token,
      `query {
        topics(first: 50, order: FOLLOWERS_COUNT${after ? `, after: "${after}"` : ""}) {
          pageInfo { hasNextPage endCursor }
          edges { node { slug name followersCount postsCount } }
        }
      }`,
    );
    const { topics } = data;
    for (const e of topics.edges) {
      all.push({
        slug: e.node.slug,
        name: e.node.name,
        followers: e.node.followersCount ?? 0,
        posts: e.node.postsCount ?? 0,
      });
    }
    if (!topics.pageInfo.hasNextPage || !topics.pageInfo.endCursor) break;
    after = topics.pageInfo.endCursor;
    // 别把 PH 打成 DDoS：40 页 × 50 条也就 9 个请求，慢一点换稳定
    await new Promise((r) => setTimeout(r, 800));
  }

  // 僵尸 topic（几十粉、十几帖）抓了也没东西，留着只会让下拉框更难选
  const kept = all.filter((t) => t.followers >= 200 || t.posts >= 50);
  const out = {
    generatedAt: new Date().toISOString().slice(0, 10),
    source: "Product Hunt GraphQL topics(order: FOLLOWERS_COUNT)",
    topics: kept,
  };

  const file = path.resolve(process.cwd(), OUT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(out, null, 0)}\n`);

  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(
    `[ph-topics] 拉到 ${all.length} 个，保留 ${kept.length} 个（粉丝 ≥200 或帖子 ≥50）→ ${OUT}（${kb}KB）`,
  );
}

main().catch((e: unknown) => {
  console.error("[ph-topics] 失败：", e);
  process.exitCode = 1;
});