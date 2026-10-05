import type { UsageLimitSourceSnapshots } from "@t3tools/contracts";
import { formatSpend } from "@t3tools/shared/usageLimits";

export interface ThreadBudget {
  /** `Monthly budget`, or the source's label when its window is not a calendar period. */
  readonly label: string;
  /** `$1,224.52 left of $1,500.00`, in the same direction as Limits. */
  readonly amount: string;
}

const PERIOD_LABELS = { monthly: "Monthly", weekly: "Weekly", session: "Session" } as const;

/**
 * The spending budget an HTTP usage source reports, for the context window
 * popover: the first configured source that has one. Hub accounts are
 * subscription quotas, not budgets, and stay on the Limits page.
 */
export function threadBudget(sources: UsageLimitSourceSnapshots): ThreadBudget | null {
  for (const source of sources) {
    if (source.kind !== "http") continue;
    for (const account of source.accounts) {
      const window = account.usageLimits.windows.find((candidate) => candidate.spend);
      if (!window?.spend) continue;
      const period = window.kind === "other" ? null : PERIOD_LABELS[window.kind];
      return {
        label: period ? `${period} budget` : window.label,
        amount: formatSpend(window.spend),
      };
    }
  }
  return null;
}
