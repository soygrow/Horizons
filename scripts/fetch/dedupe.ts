import fs from "node:fs";
import path from "node:path";
import type { AITool } from "@horizons/shared";

export const TOOLS_PATH = path.resolve(process.cwd(), "content/aitools.json");

/** 读取现有工具（不存在则空数组） */
export function loadExisting(): AITool[] {
  try {
    const raw = fs.readFileSync(TOOLS_PATH, "utf-8");
    return JSON.parse(raw) as AITool[];
  } catch {
    return [];
  }
}

/** 按 domain 去重 */
export function findDuplicates(
  candidates: AITool[],
  existing: AITool[],
): { fresh: AITool[]; duplicates: AITool[] } {
  const seen = new Set(existing.map((t) => t.domain));
  const fresh: AITool[] = [];
  const duplicates: AITool[] = [];
  const local = new Set<string>();

  for (const c of candidates) {
    if (seen.has(c.domain) || local.has(c.domain)) {
      duplicates.push(c);
    } else {
      local.add(c.domain);
      fresh.push(c);
    }
  }
  return { fresh, duplicates };
}
