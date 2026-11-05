/**
 * 给只有 "Other" 一个分类的站重新归类。
 *
 * 背景：LLM 归类阶段大量站只拿到 Other（占上榜 1/5），分类筛选因此形同虚设。
 * 当前环境访问不到 LLM，改用可审计的关键词加权规则：强词 3 分、弱词 1 分，
 * 取最高分且达到阈值者；拿不准的一律保留 Other，宁可少分也不乱分。
 *
 * 用法：pnpm tsx scripts/fetch/reclassify-other.ts [--dry] [--min=3]
 */
import "./config";
import fs from "node:fs";

const DRY = process.argv.includes("--dry");
const MIN = Number(process.argv.find((a) => a.startsWith("--min="))?.split("=")[1] ?? 3);
const FILE = "content/aitools.json";

type Cat = "AI Chat" | "Image Gen" | "Video" | "Voice & Audio" | "Writing" | "Coding" | "Automation" | "Marketing" | "Productivity" | "Data & Analytics";

const RULES: Array<{ cat: Cat; strong: string[]; weak: string[] }> = [
  {
    cat: "Video",
    strong: ["视频", "剪辑", "短片", "影视", "video agent", "video generat", "text-to-video", "文生视频", "图生视频"],
    weak: ["video", "clip", "footage", "字幕", "movie"],
  },
  {
    cat: "Image Gen",
    strong: ["图像", "图片", "绘图", "插画", "视觉内容", "文生图", "image generat", "3d场景", "3d模型", "2k 编辑"],
    weak: ["视觉", "设计", "渲染", "image", "photo", "render", "pixel", "3d"],
  },
  {
    cat: "Voice & Audio",
    strong: ["语音", "音频", "转写", "转录", "音色", "采样器", "配音", "音乐", "speech", "transcri", "text-to-speech"],
    weak: ["声音", "voice", "audio", "sound"],
  },
  {
    cat: "Coding",
    strong: ["代码审查", "代码生成", "编程", "编码", "开发者", "claude code", "ide", "sdk", "命令行", "终端", "bug", "漏洞", "仓库", "agent harness", "mcp server", "多代理", "调试", "扩散 llm", "本地 ai", "开放权重"],
    weak: ["coding", "code", "developer", "repo", "cli", "api", "框架", "部署", "测试", "编译", "推理", "模型", "运维"],
  },
  {
    cat: "Automation",
    strong: ["自动化", "工作流", "webhook", "审批", "编排", "触发器", "无代码", "rpa", "连接器"],
    weak: ["workflow", "automation", "integrat", "no-code", "接入"],
  },
  {
    cat: "Marketing",
    strong: ["营销", "销售", "获客", "广告", "seo", "增长", "线索", "sdr", "外呼", "campaign", "客户成功", "b2b", "出席率"],
    weak: ["marketing", "sales", "lead", "growth", "推广", "品牌"],
  },
  {
    cat: "Data & Analytics",
    strong: ["数据分析", "商业智能", "仪表盘", "金融数据", "财报", "搜索引擎", "知识库", "投资", "mri"],
    weak: ["数据", "分析", "search", "analytics", "bi", "database", "统计", "记忆", "洞察", "指标"],
  },
  {
    cat: "Writing",
    strong: ["写作", "文案", "生成文档", "博客", "排版", "copywrit"],
    weak: ["writing", "write", "文档", "内容生成", "编辑"],
  },
  {
    cat: "AI Chat",
    strong: ["聊天机器人", "chatbot", "个人 agi", "个人助理", "chatgpt", "对话式", "ai 助手"],
    weak: ["assistant", "chat", "对话", "问答", "助手", "agent"],
  },
  {
    cat: "Productivity",
    strong: ["会议", "待办", "任务管理", "收件箱", "日程", "效率工具", "刘海", "截图", "录屏", "办公", "协作", "云账单", "财务", "锁屏", "mac 窗口"],
    weak: ["productivity", "效率", "笔记", "邮件", "mac", "windows", "工作空间", "提醒", "屏幕"],
  },
];

interface Row {
  domain: string;
  name?: string;
  description?: string;
  categories?: string[];
  [k: string]: unknown;
}

function score(text: string, words: string[], weight: number): number {
  let s = 0;
  for (const w of words) {
    if (text.includes(w)) s += weight;
  }
  return s;
}

function classify(row: Row): { cat: Cat; score: number; detail: string } | null {
  const text = `${row.name ?? ""} ${row.description ?? ""} ${row.domain}`.toLowerCase();
  let best: { cat: Cat; score: number; detail: string } | null = null;
  for (const r of RULES) {
    const s = score(text, r.strong, 3) + score(text, r.weak, 1);
    if (s > 0 && (!best || s > best.score)) {
      const hit = [...r.strong, ...r.weak].filter((w) => text.includes(w)).slice(0, 3).join("/");
      best = { cat: r.cat, score: s, detail: hit };
    }
  }
  return best && best.score >= MIN ? best : null;
}

function main(): void {
  const all = JSON.parse(fs.readFileSync(FILE, "utf8")) as Row[];
  const targets = all.filter((t) => t.categories?.length === 1 && t.categories[0] === "Other");
  console.log(`目标 ${targets.length} 站，阈值 ${MIN}\n`);

  /** 规则拿不准、但描述已足够明确的站，人工指定；facia/protex 属安全类，无对应分类，保持 Other */
  const OVERRIDE: Record<string, Cat> = {
    "heysquint.com": "Productivity",
    "vibesmonitor.com": "Coding",
    "3am.si": "Coding",
    "agibot.sh": "AI Chat",
    "cognitum.one": "Productivity",
    "contextengine.com": "Automation",
    "mosaico.ai": "Coding",
    "openllm.sh": "Coding",
    "getoffgridai.co": "Productivity",
    "intrascope.app": "Automation",
  };

  let changed = 0;
  let kept = 0;
  for (const t of targets) {
    const forced = OVERRIDE[t.domain];
    const res = forced ? { cat: forced, score: 99, detail: "人工指定" } : classify(t);
    if (!res) {
      kept++;
      console.log(`  保留 Other  ${t.domain.padEnd(24)} ${(t.description ?? "").slice(0, 44)}`);
      continue;
    }
    changed++;
    console.log(`  ${res.cat.padEnd(16)} ${t.domain.padEnd(24)} (${res.score}) ${res.detail}`);
    if (!DRY) t.categories = [res.cat];
  }

  if (!DRY && changed > 0) {
    fs.writeFileSync(FILE, `${JSON.stringify(all, null, 2)}\n`);
    console.log(`\n写回 ${FILE}`);
  }
  console.log(`\n改判 ${changed}，保留 Other ${kept}${DRY ? "（dry）" : ""}`);
}

main();