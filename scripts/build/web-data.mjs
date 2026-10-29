/**
 * 生成前端专用的 GitHub 数据：content/github.json → content/github-web.json
 *
 * 背景：content/github.json 里 readme 字段占 12MB+（全文用于情报生成），
 * 但前端运行时用不到——综合得分已由采集阶段预存进 productScore，
 * repoScore() 不会重算。把 readme 从产出里去掉后，Worker bundle 从 31MB 降到约 15MB，
 * 冷启动与 CPU 超限（error 1102）明显缓解。
 *
 * 兜底：个别条目若缺 productScore，则保留前 3000 字 readme（score.ts 只读前 3000 字）。
 */
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const srcPath = resolve(root, "content/github.json");
const outPath = resolve(root, "content/github-web.json");

const src = JSON.parse(readFileSync(srcPath, "utf8"));
const repos = (src.repos ?? []).map((r) => {
  const { readme, ...rest } = r;
  if (!rest.productScore && readme) rest.readme = readme.slice(0, 3000);
  return rest;
});

writeFileSync(
  outPath,
  JSON.stringify({ updatedAt: src.updatedAt, ruleVersion: src.ruleVersion, repos }),
);

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(2);
console.log(
  `[web-data] ${repos.length} 个仓库 · github.json ${mb(srcPath)}MB → github-web.json ${mb(outPath)}MB`,
);