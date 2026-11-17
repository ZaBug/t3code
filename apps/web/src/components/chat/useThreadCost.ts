import type { EnvironmentId, ThreadId, UsageCostEstimate } from "@t3tools/contracts";
import { useState } from "react";

import {
  collectThreadCostInputs,
  combineThreadCost,
  type ThreadCost,
} from "@t3tools/client-runtime/thread-cost";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

/**
 * The open thread's cost: provider-reported turns summed here, the rest priced
 * by the server once per change in their token totals. While a new estimate
 * loads, the last one for the same thread stays so the figure never vanishes.
 */
export function useThreadCost(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly projection: Parameters<typeof collectThreadCostInputs>[0] | null;
  readonly enabled: boolean;
}): ThreadCost | null {
  // Read the arrays, which keep their identity while text streams, so this reruns per turn.
  const { providerTurns, providerThreads, nodes, runs } = input.projection ?? {};
  const inputs =
    input.enabled && providerTurns && providerThreads && nodes && runs
      ? collectThreadCostInputs({ providerTurns, providerThreads, nodes, runs })
      : null;
  const scope =
    input.environmentId === null || input.threadId === null
      ? null
      : `${input.environmentId}:${input.threadId}`;
  const entries = inputs?.estimateEntries ?? [];
  const current = useEnvironmentQuery(
    input.environmentId === null || entries.length === 0
      ? null
      : serverEnvironment.estimateUsageCost({
          environmentId: input.environmentId,
          input: { entries },
        }),
  ).data;

  // Remembered from earlier renders, the React way to keep a previous value.
  const [last, setLast] = useState<{
    readonly scope: string;
    readonly value: UsageCostEstimate;
  } | null>(null);
  if (current !== null && scope !== null && (last?.scope !== scope || last.value !== current)) {
    setLast({ scope, value: current });
  }
  const estimate = current ?? (last !== null && last.scope === scope ? last.value : null);
  return inputs ? combineThreadCost(inputs, estimate) : null;
}
