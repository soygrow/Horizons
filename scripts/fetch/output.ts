import fs from "node:fs";
import path from "node:path";
import type { AITool } from "@horizons/shared";

const TOOLS_PATH = path.resolve(process.cwd(), "content/aitools.json");

/** 追加工具到 content/aitools.json */
export function appendTools(items: AITool[]): void {
  let existing: AITool[] = [];
  try {
    existing = JSON.parse(fs.readFileSync(TOOLS_PATH, "utf-8")) as AITool[];
  } catch {
    existing = [];
  }
  const merged = [...existing, ...items];
  fs.writeFileSync(
    TOOLS_PATH,
    JSON.stringify(merged, null, 2) + "\n",
    "utf-8",
  );
}
