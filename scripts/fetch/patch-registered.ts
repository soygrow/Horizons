import "./config";
import fs from "node:fs";

import { fetchRegistrationDate } from "./sources/site-audit";

/**
 * 补齐缺失的域名注册时间（RDAP，免费）。
 *
 * 用法：pnpm tsx scripts/fetch/patch-registered.ts [--dry] [域名...]
 * 不带域名时读取 /tmp/no-reg.txt。
 *
 * 注意：.ai 注册表 2017-12 迁移会重置 Creation Date，
 * 落在 2017-12-14 ~ 2017-12-17 的 .ai 结果会同时打 registeredAtSuspect 标记。
 */
const DRY = process.argv.includes("--dry");
const argDomains = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const listPath = "/tmp/no-reg.txt";
const domains = argDomains.length
  ? argDomains
  : fs
      .readFileSync(listPath, "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

const file = "content/aitools.json";
const all = JSON.parse(fs.readFileSync(file, "utf8")) as Array<Record<string, any>>;

const isSuspect = (domain: string, at: string): boolean =>
  /\.ai$/i.test(domain) && at >= "2017-12-14" && at <= "2017-12-17";

async function main(): Promise<void> {
  let ok = 0;
  let miss = 0;
  /** 并发 3，避免把 RDAP 端点打限流 */
  const queue = [...domains];
  const workers = Array.from({ length: 3 }, async () => {
    for (;;) {
      const domain = queue.shift();
      if (!domain) return;
      const tool = all.find((t) => t.domain === domain);
      if (!tool) {
        miss++;
        continue;
      }
      if (tool.metrics?.registeredAt) continue;
      const at = await fetchRegistrationDate(domain);
      if (!at) {
        console.log(`✗ ${domain} 无 RDAP 记录`);
        miss++;
        continue;
      }
      const suspect = isSuspect(domain, at);
      console.log(`✓ ${domain} ${at.slice(0, 10)}${suspect ? "（注册局迁移日）" : ""}`);
      if (!DRY) {
        tool.metrics = {
          ...(tool.metrics ?? {}),
          registeredAt: at,
          ...(suspect ? { registeredAtSuspect: true } : {}),
        };
      }
      ok++;
    }
  });
  await Promise.all(workers);

  if (!DRY && ok > 0) {
    fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
    console.log(`\n写回 ${file}：成功 ${ok}，失败 ${miss}`);
  } else {
    console.log(`\n成功 ${ok}，失败 ${miss}${DRY ? "（dry）" : ""}`);
  }
}

void main();