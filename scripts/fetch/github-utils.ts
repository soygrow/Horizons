import type { GitHubRepo, GitHubSnapshot } from "@horizons/shared";

/**
 * GitHub 采集公用工具：分类映射、热度、首日历史回填、README 摘要。
 * 供 enrich-github.ts（增量刷新）与 rebuild-github.ts（按收录原则重建榜单）共用。
 */

/**
 * 用途分类映射。
 *
 * 顺序 = 优先级（先命中先占位，最多保留 3 个，第一个作为列表"用途"主标签）：
 * 具体形态（视频/图像/语音/检索/推理/编程/写作/营销/数据/效率/自动化）
 * 排在"智能体"和泛对话之前——否则一个 `llm + agent + video` 的仓库会被标成"智能体"，
 * 榜单里就全是一个标签了。Agent 只收「没有更具体形态」的智能体项目。
 */
export function mapCategories(topics: string[] = []): string[] {
  const joined = topics.join(" ").toLowerCase();
  const cats = new Set<string>();
  if (/video|movie|animation|text-to-video|talking-head|avatar/.test(joined)) cats.add("Video");
  if (/image|diffusion|stable-diffusion|photo|picture|text-to-image|img2img|comfyui|inpaint/.test(joined))
    cats.add("Image Gen");
  if (/audio|voice|tts|speech|sound|music|text-to-speech|asr|whisper/.test(joined))
    cats.add("Voice & Audio");
  if (/rag|retrieval|embedding|vector|knowledge-base|knowledge-graph|semantic-search/.test(joined))
    cats.add("RAG");
  if (/inference|serving|llm-serving|model-server|vllm|ollama|quantization|local-llm/.test(joined))
    cats.add("Inference");
  if (/coding|code|developer|programming|ide|cli|sdk|code-review|copilot/.test(joined)) cats.add("Coding");
  if (/writing|writer|content|copy|summar|translate|seo/.test(joined)) cats.add("Writing");
  if (/marketing|sales|ads|crm|lead-gen/.test(joined)) cats.add("Marketing");
  if (/data|analytics|database|sql|spreadsheet|machine-learning|deep-learning/.test(joined))
    cats.add("Data & Analytics");
  if (/productivity|task|todo|workspace|note|ppt|slides|presentation|doc|pdf|meeting/.test(joined))
    cats.add("Productivity");
  if (/automation|no-code|workflow|integration|zapier|rpa|scraping|browser/.test(joined))
    cats.add("Automation");
  if (/agent|autonomous|multi-agent|orchestr|mcp/.test(joined)) cats.add("Agent");
  if (/chat|gpt|llm|chatbot|assistant|conversation|prompt/.test(joined)) cats.add("AI Chat");
  if (cats.size === 0) cats.add("Other");
  return [...cats].slice(0, 3);
}

export function heatFromStars(stars: number): number {
  return Math.min(100, Math.round(Math.log10(stars + 1) * 20));
}

export function shiftDate(dateStr: string, delta: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** 确定性日增速比例（0.0006~0.0018），由 fullName 决定，保证形状稳定 */
export function hashRate(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return 0.0006 + ((h % 1000) / 1000) * 0.0012;
}

/**
 * 首日回填：当 history 不足 30 点时，以「当日真实 stars」为终点反推近 30 天估算序列，
 * 让趋势图立刻有形状。已累积到 30+ 真实点的仓库不再回填（保留真实数据）。
 */
export function backfillHistory(repo: GitHubRepo): GitHubSnapshot[] {
  const existing = repo.history ?? [];
  if (existing.length >= 30) return existing;
  const today = new Date().toISOString().slice(0, 10);
  const stars = repo.stars;
  const rate = hashRate(repo.fullName);
  const ratioForks = repo.stars > 0 ? repo.forks / repo.stars : 0;
  const ratioIssues = repo.stars > 0 ? repo.openIssues / repo.stars : 0;
  const days = 30;
  const points: GitHubSnapshot[] = [];
  for (let i = 0; i < days; i++) {
    const date = shiftDate(today, -(days - 1 - i));
    const factor = Math.pow(1 / (1 + rate), days - 1 - i); // 第 days-1 天 factor=1 → 真实当日值
    const s = Math.max(0, Math.round(stars * factor));
    points.push({
      date,
      stars: s,
      forks: Math.round(s * ratioForks),
      openIssues: Math.round(s * ratioIssues),
    });
  }
  return points;
}

export function readmeSummary(readme: string): string {
  const clean = readme
    .replace(/[#>*`_\-[\]()!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.slice(0, 400);
}