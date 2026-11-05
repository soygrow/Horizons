#!/usr/bin/env node
/**
 * 生成后台管理密码的 PBKDF2-SHA256 哈希，供 `wrangler secret put ADMIN_PASSWORD_HASH` 使用。
 *
 * 用法：
 *   node apps/api/scripts/admin-password.mjs            # 交互输入，不回显
 *   ADMIN_PASSWORD='...' node apps/api/scripts/admin-password.mjs
 *   node apps/api/scripts/admin-password.mjs '...'      # 注意 shell 历史会留痕
 *
 * 哈希格式必须与 apps/api/src/routes/admin.ts 的 parsePasswordHash 保持一致：
 *   pbkdf2$sha256$<iterations>$<saltBase64Url>$<hashBase64Url>
 */
import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import process, { stdin, stdout } from "node:process";

const ITERATIONS = 210_000;
const MIN_LENGTH = 12;

function base64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function promptHidden(label) {
  if (!stdin.isTTY) {
    throw new Error("非交互环境，请改用 ADMIN_PASSWORD=... 或第一个参数传入密码");
  }
  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          stdout.write("\n");
          reject(new Error("已取消"));
          return;
        }
        if (ch === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const fromEnv = process.env.ADMIN_PASSWORD;
const fromArgv = process.argv[2];
const password = fromEnv ?? fromArgv ?? (await promptHidden("设置后台密码（不回显）: "));

if (password.length < MIN_LENGTH) {
  console.error(`密码至少 ${MIN_LENGTH} 位，建议 16 位以上并混用大小写、数字与符号。`);
  process.exit(1);
}

const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");

// 自检：重新推导一次，确认格式与解析器一致，避免设进去却登不上
const check = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
if (!timingSafeEqual(hash, check)) {
  console.error("哈希自检失败，请重试。");
  process.exit(1);
}

const encoded = `pbkdf2$sha256$${ITERATIONS}$${base64Url(salt)}$${base64Url(hash)}`;

console.log("\n把下面这条写进 Cloudflare Secret（不要提交到仓库）：\n");
console.log(`  cd apps/api && pnpm exec wrangler secret put ADMIN_PASSWORD_HASH`);
console.log(`  粘贴：${encoded}\n`);
console.log("用户名同样用 Secret 保存：");
console.log(`  cd apps/api && pnpm exec wrangler secret put ADMIN_USERNAME\n`);
console.log("本地开发请写进 apps/api/.dev.vars：");
console.log(`  ADMIN_USERNAME=your-name`);
console.log(`  ADMIN_PASSWORD_HASH=${encoded}\n`);
console.log(`密码长度 ${password.length} 位，迭代次数 ${ITERATIONS}，盐 ${base64Url(salt)}`);