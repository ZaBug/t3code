import type { EnvironmentId, UsageCostEstimate, UsageCostEstimateInput } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import {
  collectThreadCostInputs,
  combineThreadCost,
  type ThreadCost,
  type ThreadCostInputs,
} from "../../lib/threadCost";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * The open thread's cost: provider-reported turns summed on the client, the
 * rest priced by the server. The estimate is requested again only when the
 * unreported token totals change, which happens once per finished turn.
 */
export function useThreadCost(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projection: Parameters<typeof collectThreadCostInputs>[0] | null;
  readonly enabled: boolean;
}): ThreadCost | null {
  const estimateCost = useAtomCommand(serverEnvironment.estimateUsageCost, {
    reportFailure: false,
  });
  // Keyed on the arrays it reads, which keep their identity while text streams.
  const providerTurns = input.projection?.providerTurns;
  const providerThreads = input.projection?.providerThreads;
  const nodes = input.projection?.nodes;
  const runs = input.projection?.runs;
  const inputs = useMemo<ThreadCostInputs | null>(
    () =>
      input.enabled && providerTurns && providerThreads && nodes && runs
        ? collectThreadCostInputs({ providerTurns, providerThreads, nodes, runs })
        : null,
    [input.enabled, providerTurns, providerThreads, nodes, runs],
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

  return useMemo(
    () =>
      inputs
        ? combineThreadCost(inputs, estimate?.key === entriesKey ? estimate.value : null)
        : null,
    [entriesKey, estimate, inputs],
  );
}
