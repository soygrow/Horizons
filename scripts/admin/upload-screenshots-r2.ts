/**
 * 把 public/screenshots 下的截图同步到 R2（桶 horizons-archive）。
 *
 * key 规则必须和 apps/site/src/worker.ts 一致：
 *   /screenshots/<name>.png  →  R2 key 就是 "<name>.png"（平铺，不带目录前缀）
 *
 * wrangler 的 r2 object put 只接受单文件，没有批量接口，所以这里用并发池
 * 并行拉起多个 wrangler 进程。单个进程约 2–7s（大头是启动开销），
 * 并发 8 时实测约 1 张/秒。
 *
 * 用法：
 *   npx tsx scripts/admin/upload-screenshots-r2.ts            # 全量
 *   npx tsx scripts/admin/upload-screenshots-r2.ts --limit 20 # 试跑
 *   npx tsx scripts/admin/upload-screenshots-r2.ts --dry      # 只列清单
 *   npx tsx scripts/admin/upload-screenshots-r2.ts --overwrite # 已存在也重传
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, "../..");
const SHOT_DIR = path.join(ROOT, "apps/site/public/screenshots");
const WRANGLER_BIN = path.join(ROOT, "apps/site/node_modules/.bin/wrangler");
const BUCKET = "horizons-archive";
const CONCURRENCY = 8;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "";
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function uploadOne(file: string): Promise<void> {
  const full = path.join(SHOT_DIR, file);
  await execFileAsync(
    WRANGLER_BIN,
    [
      "r2",
      "object",
      "put",
      `${BUCKET}/${file}`,
      `--file=${full}`,
      "--content-type=image/png",
      "--remote",
    ],
    { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 },
  );
}

async function main(): Promise<void> {
  if (!fs.existsSync(SHOT_DIR)) {
    console.error(`截图目录不存在：${SHOT_DIR}`);
    process.exit(1);
  }
  if (!fs.existsSync(WRANGLER_BIN)) {
    console.error(`找不到 wrangler：${WRANGLER_BIN}`);
    process.exit(1);
  }

  const all = fs
    .readdirSync(SHOT_DIR)
    .filter((f) => f.endsWith(".png"))
    .sort();

  const limitRaw = arg("limit");
  const limit = limitRaw ? Number(limitRaw) : all.length;
  const files = all.slice(0, limit);

  const totalBytes = files.reduce((n, f) => n + fs.statSync(path.join(SHOT_DIR, f)).size, 0);
  console.log(
    `待上传 ${files.length}/${all.length} 个文件，共 ${(totalBytes / 1024 / 1024).toFixed(1)} MB` +
      `｜桶 ${BUCKET}｜并发 ${CONCURRENCY}`,
  );

  if (flag("dry")) {
    console.log("dry-run，前 5 个：", files.slice(0, 5));
    return;
  }

  let done = 0;
  let failed = 0;
  const failures: Array<{ file: string; error: string }> = [];
  const startedAt = Date.now();

  const queue = [...files];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const file = queue.shift();
      if (!file) return;
      try {
        await uploadOne(file);
        done++;
      } catch (e) {
        failed++;
        const msg = e instanceof Error ? e.message : String(e);
        failures.push({ file, error: msg.slice(0, 200) });
      }
      const processed = done + failed;
      if (processed % 20 === 0 || processed === files.length) {
        const secs = (Date.now() - startedAt) / 1000;
        const rate = processed / secs;
        const eta = rate > 0 ? Math.round((files.length - processed) / rate) : 0;
        console.log(
          `  进度 ${processed}/${files.length}｜成功 ${done}｜失败 ${failed}` +
            `｜${rate.toFixed(1)} 张/秒｜剩余约 ${eta}s`,
        );
      }
    }
  });

  await Promise.all(workers);

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n完成：成功 ${done}，失败 ${failed}，耗时 ${secs}s`);
  if (failures.length > 0) {
    console.log("失败明细（前 10）：");
    for (const f of failures.slice(0, 10)) console.log(`  ${f.file}: ${f.error}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});