/**
 * 每日情报落库 —— 后台看往期用。
 *
 * 站点构建仍读 content/digest/<date>.json（静态路径 /daily/[date]），
 * 这里把整期 JSON 另存一份进 digest_issues：
 *   - 后台列往期、看全文不再打 GitHub Contents API；
 *   - 单期 15KB 左右，一条语句就能写完，不需要像位次快照那样分片。
 *
 * 写入失败只告警：情报已经生成了文件和榜单行，不能因为后台副本失败而回滚。
 */
import { createD1Client, d1Configured } from "./d1-client";

export interface DigestIssueLike {
  date: string;
  generatedAt?: string;
  [key: string]: unknown;
}

export async function saveDigestIssue(issue: DigestIssueLike): Promise<boolean> {
  if (!d1Configured()) {
    console.warn(`[digest] 未配置 D1 通道，跳过 ${issue.date} 落库（文件已写）`);
    return false;
  }

  try {
    await createD1Client().query(
      `INSERT INTO digest_issues (date, payload, generated_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (date) DO UPDATE SET
         payload = excluded.payload,
         generated_at = excluded.generated_at,
         updated_at = excluded.updated_at`,
      [issue.date, JSON.stringify(issue), issue.generatedAt ?? null, Date.now()],
    );
    return true;
  } catch (e) {
    console.warn(`[digest] 写入 ${issue.date} 失败（不影响产物）：`, e);
    return false;
  }
}