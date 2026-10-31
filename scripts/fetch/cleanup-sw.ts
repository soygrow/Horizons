import fs from "node:fs";
import path from "node:path";
import type { AITool, AIToolCategory } from "@horizons/shared";

/**
 * 一次性整理「相似站点」扩充进来的数据。
 *
 * 相似站点扩容快，但会带进三类问题，本脚本一次性修掉：
 *   1. 非 AI 产品 / 大厂子域 / 目录站 —— 直接剔除（原则 A1、A2）
 *   2. 分类不准（大量落到 Other）—— 按已知产品归位
 *   3. 描述抓到的是隐私政策、服务条款 —— 换成中性描述，避免榜单上出现「Privacy Policy」
 */

const TOOLS_PATH = path.resolve(process.cwd(), "content/aitools.json");

/** 剔除：非 AI 产品、大厂子域、目录站 */
const REMOVE = new Set([
  "nothing.tech", // 智能手表
  "build.nvidia.com", // NVIDIA 大厂子域
  "komprise.com", // 企业非结构化数据管理
  "semarchy.com", // 企业主数据管理
  "rhombus.com", // 企业安防
  "toolhunt.io", // AI 导航站
  "futuretools.io",
  "kaggle.com",
  "larksuite.com",
  "zegocloud.com",
  "typeform.com",
]);

/** 分类归位：这些站被 SimilarWeb 类目映射到了 Other/Coding，实际归属明确 */
const CATEGORY_FIX: Record<string, AIToolCategory> = {
  "suno.com": "Voice & Audio",
  "lalal.ai": "Voice & Audio",
  "typecast.ai": "Voice & Audio",
  "fireflies.ai": "Productivity",
  "popvid.ai": "Video",
  "heyvid.ai": "Video",
  "vidsoul.ai": "Video",
  "musevideo.ai": "Video",
  "spot.ai": "Video",
  "hix.ai": "Writing",
  "netus.ai": "Writing",
  "yomu.ai": "Writing",
  "thesisai.io": "Writing",
  "sourcely.net": "Data & Analytics",
  "dacon.io": "Data & Analytics",
  "diffbot.com": "Data & Analytics",
  "agent.so": "AI Chat",
  "soulfun.ai": "AI Chat",
  "wizr.ai": "AI Chat",
  "sobot.io": "Marketing",
  "docsbot.ai": "Marketing",
  "deepinfra.com": "Coding",
  "fireworks.ai": "Coding",
  "replicate.com": "Coding",
  "tavily.com": "Coding",
  "justoneapi.com": "Coding",
  "dust.tt": "Automation",
  "promptai.co": "Image Gen",
  "soulgen.net": "Image Gen",
  "design-extractor.com": "Image Gen",
  "atlabs.ai": "Image Gen",
};

/** 明显不是产品描述的内容（隐私政策、条款、cookie 声明等） */
const BAD_DESC =
  /privacy policy|terms of service|terms and conditions|cookie policy|隐私政策|服务条款|개인정보|利用規約|this website uses cookies/i;

function main(): void {
  const tools = JSON.parse(fs.readFileSync(TOOLS_PATH, "utf-8")) as AITool[];
  let removed = 0;
  let recategorized = 0;
  let redescribed = 0;

  const out: AITool[] = [];
  for (const t of tools) {
    if (REMOVE.has(t.domain)) {
      removed++;
      continue;
    }
    const fix = CATEGORY_FIX[t.domain];
    if (fix && (!t.categories.includes(fix) || t.categories.length > 1)) {
      t.categories = [fix];
      recategorized++;
    }
    if (BAD_DESC.test(t.description ?? "")) {
      const visits = t.trafficMetrics?.monthlyVisits;
      t.description = visits
        ? `${t.name} 官方网站，月访问量 ${visits.toLocaleString()}。详情请见官网。`
        : `${t.name} 官方网站。`;
      t.descriptionSource = "auto";
      redescribed++;
    }
    out.push(t);
  }

  const tmp = `${TOOLS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, TOOLS_PATH);

  console.log(`[cleanup] 剔除 ${removed}｜修正分类 ${recategorized}｜重写描述 ${redescribed}｜剩余 ${out.length} 站`);
}

main();