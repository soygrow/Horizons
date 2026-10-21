import type { PricingModel } from "@/lib/types";
import { pricingModelLabels } from "@/lib/data";

const styles: Record<PricingModel, string> = {
  free: "bg-accent-soft text-accent",
  freemium: "bg-primary-soft text-primary",
  paid: "bg-violet-500/15 text-violet-300",
};

export function PricingTag({ model }: { model?: PricingModel }) {
  if (!model) {
    return <span className="text-xs text-ink-muted">—</span>;
  }
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${styles[model]}`}
    >
      {pricingModelLabels[model]}
    </span>
  );
}
