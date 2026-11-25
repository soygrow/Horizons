/**
 * 每日情报落库 —— 情报的唯一真源。
 *
 * 整期 JSON 原样存进 `digest_issues.payload`：
 *   - 站点构建前由 `scripts/admin/hydrate-digest.ts` 还原成
 *     `content/digest/<date>.json`（静态路径 /daily/[date] 照旧按文件生成）；
 *   - 后台列往期、看全文、判断草稿/已发布、手改几句话都只读这张表；
 *   - 单期 8KB 左右，一条语句就能写完，不需要像位次快照那样分片。
 *
 * 写入失败只告警：文件已经在 runner 上生成，不能因为后台副本失败而回滚，
 * 但「库里有几期，站点就有几期」靠的就是这里写成功 —— 所以失败不能静默。
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