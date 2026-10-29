import type { ClaimType, TrendConfidence, TrendStatus } from "@horizons/shared";
import { claimTypeMeta, trendConfidenceMeta, trendStatusMeta } from "@/lib/trends";

/** 趋势阶段徽章：正在爆发 / 持续增长 / 新词观察 / 热度回落 */
export function TrendStatusBadge({
  status,
  withHint = false,
}: {
  status: TrendStatus;
  withHint?: boolean;
}) {
  const meta = trendStatusMeta[status];
  return (
    <span
      title={meta.hint}
      className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
      {withHint ? <span className="font-normal opacity-80">{meta.hint}</span> : null}
    </span>
  );
}

/** 趋势可信度：自定义证据等级，非 Google 官方指标 */
export function TrendConfidenceBadge({
  confidence,
  showLabel = true,
}: {
  confidence: TrendConfidence;
  showLabel?: boolean;
}) {
  const meta = trendConfidenceMeta[confidence];
  return (
    <span
      title={meta.hint}
      className={`inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}
    >
      {showLabel ? `可信度 ${meta.label}` : meta.label}
    </span>
  );
}

/** 结论类型：已验证事实 / 合理推断 / 待验证假设 */
export function ClaimTypeBadge({ type }: { type: ClaimType }) {
  const meta = claimTypeMeta[type];
  return (
    <span className={`inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}>
      {meta.label}
    </span>
  );
}