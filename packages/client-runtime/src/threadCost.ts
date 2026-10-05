import type {
  OrchestrationV2ThreadProjection,
  ProviderDriverKind,
  UsageCostEstimate,
  UsageCostEstimateInput,
} from "@t3tools/contracts";
import { formatMoney } from "@t3tools/shared/usageLimits";

/**
 * What a thread's turns say about its cost before pricing: the provider-reported
 * sum, and the token totals per model of turns that report no cost (Codex,
 * OpenCode, Claude turns from before cost was recorded) for the server to price.
 */
export interface ThreadCostInputs {
  readonly reportedUsd: number;
  readonly reportedTurns: number;
  /** The driver of the reported turns when they all share one, for the label. */
  readonly reportedBy: ProviderDriverKind | null;
  readonly estimateEntries: UsageCostEstimateInput["entries"];
}

export function collectThreadCostInputs(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "providerTurns" | "providerThreads" | "nodes" | "runs"
  >,
): ThreadCostInputs {
  const runModel = new Map(projection.runs.map((run) => [run.id, run.modelSelection.model]));
  const nodeRun = new Map(projection.nodes.map((node) => [node.id, node.runId]));
  const threadDriver = new Map(
    projection.providerThreads.map((thread) => [thread.id, thread.driver]),
  );
  let reportedUsd = 0;
  let reportedTurns = 0;
  const reportedDrivers = new Set<ProviderDriverKind>();
  const totalsByModel = new Map<string, UsageCostEstimateInput["entries"][number]["totals"]>();
  for (const turn of projection.providerTurns) {
    if (turn.reportedCostUsd !== undefined) {
      reportedUsd += turn.reportedCostUsd;
      reportedTurns += 1;
      const driver = threadDriver.get(turn.providerThreadId);
      if (driver !== undefined) reportedDrivers.add(driver);
      continue;
    }
    const usage = turn.turnTokenUsage;
    if (
      usage === undefined ||
      usage.inputTokens === undefined ||
      usage.outputTokens === undefined
    ) {
      continue;
    }
    const runId = nodeRun.get(turn.nodeId);
    const model = runId ? runModel.get(runId) : undefined;
    if (model === undefined) continue;
    // Turn input includes cache reads and writes; the price table charges them apart.
    const cached = usage.cachedInputTokens ?? 0;
    const cacheCreation = usage.cacheCreationTokens ?? 0;
    const previous = totalsByModel.get(model);
    totalsByModel.set(model, {
      uncachedInputTokens:
        (previous?.uncachedInputTokens ?? 0) +
        Math.max(0, usage.inputTokens - cached - cacheCreation),
      cachedInputTokens: (previous?.cachedInputTokens ?? 0) + cached,
      cacheCreationTokens: (previous?.cacheCreationTokens ?? 0) + cacheCreation,
      outputTokens: (previous?.outputTokens ?? 0) + usage.outputTokens,
      reasoningTokens: (previous?.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
    });
  }
  return {
    reportedUsd,
    reportedTurns,
    reportedBy: reportedDrivers.size === 1 ? [...reportedDrivers][0]! : null,
    estimateEntries: [...totalsByModel].map(([model, totals]) => ({ model, totals })),
  };
}

export interface ThreadCost {
  readonly amountUsd: number;
  /** `mixed` when some turns were reported by the provider and others estimated. */
  readonly source: "provider" | "estimate" | "mixed";
  readonly reportedBy: ProviderDriverKind | null;
  /** Some estimated turns used a model with no known rate, so the figure is low. */
  readonly partial: boolean;
}

/**
 * The thread's cost once the estimate is in. While it loads, a thread with
 * reported turns shows those alone rather than nothing; a thread with neither
 * shows no row.
 */
export function combineThreadCost(
  inputs: ThreadCostInputs,
  estimate: UsageCostEstimate | null,
): ThreadCost | null {
  const estimated = inputs.estimateEntries.length > 0 && estimate !== null;
  if (inputs.reportedTurns === 0 && !estimated) return null;
  return {
    amountUsd: inputs.reportedUsd + (estimated ? estimate.costUsd : 0),
    source: inputs.reportedTurns === 0 ? "estimate" : estimated ? "mixed" : "provider",
    reportedBy: inputs.reportedBy,
    partial: estimated && estimate.unpricedModels.length > 0,
  };
}

/**
 * `reported by Claude`, `estimate`: where the thread cost came from, in a few
 * words. Each client names drivers with its own provider labels.
 */
export function threadCostSourceLabel(
  cost: ThreadCost,
  driverLabel: (driver: ProviderDriverKind) => string | undefined,
): string {
  const by = cost.reportedBy ? (driverLabel(cost.reportedBy) ?? "provider") : "provider";
  const label =
    cost.source === "provider"
      ? `reported by ${by}`
      : cost.source === "estimate"
        ? "estimate"
        : `reported by ${by} + estimate`;
  return cost.partial ? `${label}, some models unpriced` : label;
}

/** `$1.39` in the popover; amounts under a cent read `<$0.01` rather than `$0.00`. */
export function formatThreadCost(amountUsd: number): string {
  if (amountUsd > 0 && amountUsd < 0.01) return "<$0.01";
  return formatMoney(amountUsd, "USD");
}

/** `$0.42`, `$1.4`, `$123`: short enough for the composer badge. */
export function formatThreadCostCompact(amountUsd: number): string {
  if (amountUsd > 0 && amountUsd < 0.01) return "<$0.01";
  return formatMoney(amountUsd, "USD", amountUsd < 1 ? 2 : amountUsd < 100 ? 1 : 0);
}
