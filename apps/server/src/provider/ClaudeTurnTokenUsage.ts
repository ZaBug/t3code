import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderRuntimeTurnStatus, TurnTokenUsage } from "@t3tools/contracts";

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

export function normalizeClaudeTurnTokenUsage(
  result: { readonly subtype: SDKResultMessage["subtype"]; readonly usage?: unknown } | undefined,
  hasSubagents: boolean,
  terminalStatus: ProviderRuntimeTurnStatus,
): TurnTokenUsage {
  const usage = result?.usage as Record<string, unknown> | undefined;
  if (!usage) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents,
    };
  }

  const uncachedInputTokens = finiteNonNegativeInteger(usage.input_tokens);
  const cachedInputTokens = finiteNonNegativeInteger(usage.cache_read_input_tokens);
  const cacheCreationTokens = finiteNonNegativeInteger(usage.cache_creation_input_tokens);
  const rawOutputTokens = finiteNonNegativeInteger(usage.output_tokens);
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  const thinkingTokens = finiteNonNegativeInteger(outputDetails?.thinking_tokens);
  const cachedInputContribution = usage.cache_read_input_tokens == null ? 0 : cachedInputTokens;
  const cacheCreationContribution =
    usage.cache_creation_input_tokens == null ? 0 : cacheCreationTokens;
  const inputTokens =
    uncachedInputTokens !== undefined &&
    cachedInputContribution !== undefined &&
    cacheCreationContribution !== undefined
      ? uncachedInputTokens + cachedInputContribution + cacheCreationContribution
      : undefined;
  const hasKnownUsage =
    uncachedInputTokens !== undefined ||
    cachedInputTokens !== undefined ||
    cacheCreationTokens !== undefined ||
    rawOutputTokens !== undefined;
  const hasPositiveUsage =
    (uncachedInputTokens ?? 0) +
      (cachedInputTokens ?? 0) +
      (cacheCreationTokens ?? 0) +
      (rawOutputTokens ?? 0) >
    0;

  if (!hasKnownUsage || (result?.subtype !== "success" && !hasPositiveUsage)) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents,
    };
  }

  const commonUsage = {
    usageScope: "main_agent",
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(thinkingTokens !== undefined && rawOutputTokens !== undefined
      ? { reasoningTokens: Math.min(rawOutputTokens, thinkingTokens) }
      : {}),
    hasSubagents,
  } as const;
  if (
    terminalStatus === "completed" &&
    result?.subtype === "success" &&
    inputTokens !== undefined &&
    rawOutputTokens !== undefined
  ) {
    return {
      ...commonUsage,
      usageStatus: "complete",
      inputTokens,
      outputTokens: rawOutputTokens,
    };
  }
  return {
    ...commonUsage,
    usageStatus: "partial",
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(rawOutputTokens !== undefined ? { outputTokens: rawOutputTokens } : {}),
  };
}

/**
 * One Claude CLI process's running `total_cost_usd`, cumulative per session: a resumed
 * process's first total includes earlier spend, and `/clear` drops it. One state per
 * process. `totalUsd` stays null until a resumed process's first result sets it.
 */
export interface ClaudeReportedCostState {
  readonly totalUsd: number | null;
  readonly lastResultUuid: string | null;
  readonly lastTurnCostUsd: number | undefined;
}

export const initialClaudeReportedCost: ClaudeReportedCostState = {
  totalUsd: 0,
  lastResultUuid: null,
  lastTurnCostUsd: 0,
};

/** A process that resumed a session: its first total includes spend already counted. */
export const resumedClaudeReportedCost: ClaudeReportedCostState = {
  ...initialClaudeReportedCost,
  totalUsd: null,
};

/**
 * One result's share: the increase since the last result, or the whole total after a
 * drop (a reset). A resumed process's first result has no share, so its turn is
 * estimated from tokens. A replayed result keeps its first share.
 */
export function claudeTurnReportedCost(
  state: ClaudeReportedCostState,
  result: { readonly uuid: string; readonly total_cost_usd?: unknown },
): { readonly state: ClaudeReportedCostState; readonly turnCostUsd: number | undefined } {
  if (result.uuid === state.lastResultUuid) {
    return { state, turnCostUsd: state.lastTurnCostUsd };
  }
  const total = result.total_cost_usd;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
    return { state, turnCostUsd: undefined };
  }
  const turnCostUsd =
    state.totalUsd === null ? undefined : total >= state.totalUsd ? total - state.totalUsd : total;
  return {
    state: { totalUsd: total, lastResultUuid: result.uuid, lastTurnCostUsd: turnCostUsd },
    turnCostUsd,
  };
}
