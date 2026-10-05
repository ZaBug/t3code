import { formatContextWindowPercentage } from "@t3tools/client-runtime/context-window";
import { formatThreadCostCompact } from "@t3tools/client-runtime/thread-cost";

/**
 * `t3code · TMDADM1W · $1.4 · 32%`: the thread header subtitle with the
 * thread's cost and context share appended. A part without data is left out,
 * so a thread with no cost never reads `$0`; `showCost` is the device setting.
 */
export function threadHeaderSubtitle(input: {
  readonly projectTitle: string | null;
  readonly environmentLabel: string | null;
  readonly costUsd: number | null;
  readonly contextUsedPercentage: number | null;
  readonly showCost: boolean;
}): string {
  return [
    input.projectTitle,
    input.environmentLabel,
    input.showCost && input.costUsd !== null ? formatThreadCostCompact(input.costUsd) : null,
    formatContextWindowPercentage(input.contextUsedPercentage),
  ]
    .filter((part) => part !== null && part.length > 0)
    .join(" · ");
}
