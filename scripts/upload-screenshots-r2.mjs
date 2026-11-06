#!/usr/bin/env node
/**
 * 把官网截图上传到 R2（键名与站内 URL 一致：/screenshots/<file> → <file>）。
 *
 * 截图存放在 apps/site/public/screenshots（入库），
 * 新站（apps/site）构建产物里没有这些文件，于是线上全部 404。
 * 这里一次性搬到 R2，由 site 的 Worker 在 /screenshots/* 上读取。
 *
 * 用法：
 *   node scripts/upload-screenshots-r2.mjs --dry           # 只列数量与体积
 *   node scripts/upload-screenshots-r2.mjs                 # 全量上传
 *   node scripts/upload-screenshots-r2.mjs --only a.png    # 只传指定文件
 */
import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const SRC = "apps/site/public/screenshots";
const BUCKET = process.env.R2_BUCKET || "horizons-images";
const CONTENT_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const dry = process.argv.includes("--dry");
const onlyIdx = process.argv.indexOf("--only");
const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
const concurrency = Number(process.env.R2_CONCURRENCY || 6);

function putObject(key, file, contentType) {
  return new Promise((resolve) => {
    const child = spawn(
      "pnpm",
      [
        "--filter",
        "@horizons/site",
        "exec",
        "wrangler",
        "r2",
        "object",
        "put",
        `${BUCKET}/${key}`,
        `--file=${file}`,
        `--content-type=${contentType}`,
        "--remote",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => resolve({ ok: code === 0, err: err.slice(0, 200) }));
    child.on("error", (e) => resolve({ ok: false, err: e.message }));
  });
}

async function main() {
  const files = (await readdir(SRC)).filter((f) => CONTENT_TYPES[f.slice(f.lastIndexOf(".")).toLowerCase()]);
  const targets = only ? files.filter((f) => f === only || f === `${only}.png`) : files;

  let bytes = 0;
  for (const f of targets) bytes += (await stat(join(SRC, f))).size;
  console.log(`[r2] 待上传 ${targets.length} 个文件，共 ${(bytes / 1024 / 1024).toFixed(1)} MB → ${BUCKET}`);

  if (dry) {
    console.log(`[r2] --dry：未实际上传。并发 ${concurrency}，预计 ${Math.ceil(targets.length / concurrency) * 2}s`);
    return;
  }

  let done = 0;
  let failed = 0;
  const failures = [];
  let cursor = 0;

  async function worker() {
    while (cursor < targets.length) {
      const file = targets[cursor++];
      const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
      const res = await putObject(file, join(SRC, file), CONTENT_TYPES[ext]);
      if (res.ok) done++;
      else {
        failed++;
        failures.push(`${file}: ${res.err}`);
      }
      const total = done + failed;
      if (total % 20 === 0) console.log(`[r2] ${total}/${targets.length}（失败 ${failed}）`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

  console.log(`[r2] 完成：成功 ${done}｜失败 ${failed}`);
  for (const f of failures.slice(0, 10)) console.log("  ✗", f);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("[r2] 失败：", e.message);
  process.exitCode = 1;
});