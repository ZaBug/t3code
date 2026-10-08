import { useAtomValue } from "@effect/atom-react";
import {
  type ContextWindowSnapshot,
  deriveLatestContextWindowSnapshot,
} from "@t3tools/client-runtime/context-window";
import { threadBudget, type ThreadBudget } from "@t3tools/client-runtime/thread-budget";
import {
  collectThreadCostInputs,
  combineThreadCost,
  type ThreadCost,
  type ThreadCostInputs,
} from "@t3tools/client-runtime/thread-cost";
import type {
  EnvironmentId,
  OrchestrationV2ThreadProjection,
  ThreadId,
  UsageCostEstimate,
  UsageCostEstimateInput,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo, useState } from "react";

import { mobilePreferencesAtom } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadVisibleTurnItems } from "../../state/use-thread-detail";

export interface ThreadUsage {
  readonly context: ContextWindowSnapshot | null;
  /** Null while hidden by the device setting or when no turn reports usage. */
  readonly cost: ThreadCost | null;
  readonly budget: ThreadBudget | null;
  readonly showCost: boolean;
}

/**
 * The open thread's context window and cost, as web's composer popover shows
 * them. Provider-reported turns are summed here; the rest are priced by the
 * server, asked again only when the unreported token totals change, which
 * happens once per finished turn.
 */
export function useThreadUsage(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly projection: OrchestrationV2ThreadProjection | null;
}): ThreadUsage {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const showCost =
    !AsyncResult.isSuccess(preferences) || preferences.value.threadCostEnabled !== false;
  const config = useAtomValue(serverEnvironment.configValueAtom(input.environmentId));
  const visibleTurnItems = useThreadVisibleTurnItems({
    environmentId: input.environmentId,
    threadId: input.threadId,
  });
  const estimateCost = useAtomCommand(serverEnvironment.estimateUsageCost, {
    reportFailure: false,
  });
  // Keyed on the arrays they read, which keep their identity while text streams.
  const providerTurns = input.projection?.providerTurns;
  const providerThreads = input.projection?.providerThreads;
  const activeProviderThreadId = input.projection?.thread.activeProviderThreadId;
  const nodes = input.projection?.nodes;
  const runs = input.projection?.runs;

  const context = useMemo(() => {
    let liveUsage = null;
    for (let index = (providerTurns?.length ?? 0) - 1; index >= 0; index -= 1) {
      const usage = providerTurns?.[index]?.tokenUsage;
      if (usage !== undefined) {
        liveUsage = usage;
        break;
      }
    }
    return deriveLatestContextWindowSnapshot(
      visibleTurnItems,
      liveUsage,
      providerThreads?.find((thread) => thread.id === activeProviderThreadId),
    );
  }, [activeProviderThreadId, providerThreads, providerTurns, visibleTurnItems]);

  const inputs = useMemo<ThreadCostInputs | null>(
    () =>
      showCost && providerTurns && providerThreads && nodes && runs
        ? collectThreadCostInputs({ providerTurns, providerThreads, nodes, runs })
        : null,
    [showCost, providerTurns, providerThreads, nodes, runs],
  );
  const entriesKey = inputs ? JSON.stringify(inputs.estimateEntries) : null;
  const [estimate, setEstimate] = useState<{
    readonly key: string;
    readonly value: UsageCostEstimate;
  } | null>(null);

  useEffect(() => {
    if (entriesKey === null || input.environmentId === null) return;
    // The key is the entries themselves, so the effect re-runs only when they change.
    const entries = JSON.parse(entriesKey) as UsageCostEstimateInput["entries"];
    if (entries.length === 0) return;
    let cancelled = false;
    void estimateCost({ environmentId: input.environmentId, input: { entries } }).then((result) => {
      if (!cancelled && result._tag === "Success") {
        setEstimate({ key: entriesKey, value: result.value });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [entriesKey, input.environmentId, estimateCost]);

  const cost = useMemo(
    () =>
      inputs
        ? combineThreadCost(inputs, estimate?.key === entriesKey ? estimate.value : null)
        : null,
    [entriesKey, estimate, inputs],
  );
  const usageLimitSources = config?.usageLimitSources;
  const budget = useMemo(
    () => (showCost && usageLimitSources ? threadBudget(usageLimitSources) : null),
    [showCost, usageLimitSources],
  );

  return { context, cost, budget, showCost };
}
