import { describe, expect, it } from "vite-plus/test";

import {
  collectThreadCostInputs,
  combineThreadCost,
  formatThreadCost,
  formatThreadCostCompact,
  threadCostSourceLabel,
} from "./threadCost.ts";

type Projection = Parameters<typeof collectThreadCostInputs>[0];

function projection(
  turns: ReadonlyArray<{
    readonly node: string;
    readonly thread?: string;
    readonly reportedCostUsd?: number;
    readonly usage?: Record<string, unknown>;
  }>,
): Projection {
  return {
    runs: [
      { id: "run-claude", modelSelection: { model: "claude-sonnet-4-6" } },
      { id: "run-codex", modelSelection: { model: "gpt-5.5" } },
    ],
    nodes: [
      { id: "node-claude", runId: "run-claude" },
      { id: "node-codex", runId: "run-codex" },
    ],
    providerThreads: [
      { id: "pt-claude", driver: "claudeAgent" },
      { id: "pt-codex", driver: "codex" },
    ],
    providerTurns: turns.map((turn, index) => ({
      id: `turn-${index}`,
      nodeId: turn.node,
      providerThreadId: turn.thread ?? "pt-claude",
      ...(turn.reportedCostUsd === undefined ? {} : { reportedCostUsd: turn.reportedCostUsd }),
      ...(turn.usage === undefined ? {} : { turnTokenUsage: turn.usage }),
    })),
  } as unknown as Projection;
}

const usage = (input: number, output: number, cached = 0, cacheCreation = 0) => ({
  usageScope: "main_agent",
  usageStatus: "complete",
  hasSubagents: false,
  inputTokens: input,
  outputTokens: output,
  cachedInputTokens: cached,
  cacheCreationTokens: cacheCreation,
});

describe("collectThreadCostInputs", () => {
  it("sums reported turns and leaves only unreported ones to estimate", () => {
    const inputs = collectThreadCostInputs(
      projection([
        { node: "node-claude", reportedCostUsd: 0.25, usage: usage(10, 10) },
        { node: "node-claude", reportedCostUsd: 0.15, usage: usage(10, 10) },
        { node: "node-codex", thread: "pt-codex", usage: usage(1_000, 200, 300) },
        { node: "node-codex", thread: "pt-codex", usage: usage(500, 100) },
      ]),
    );
    expect(inputs.reportedUsd).toBeCloseTo(0.4);
    expect(inputs.reportedTurns).toBe(2);
    expect(inputs.reportedBy).toBe("claudeAgent");
    // Never priced twice: reported Claude turns are absent from the estimate.
    expect(inputs.estimateEntries).toEqual([
      {
        model: "gpt-5.5",
        totals: {
          uncachedInputTokens: 1_200,
          cachedInputTokens: 300,
          cacheCreationTokens: 0,
          outputTokens: 300,
          reasoningTokens: 0,
        },
      },
    ]);
  });

  it("skips turns with no usage or no known model", () => {
    const inputs = collectThreadCostInputs(
      projection([
        { node: "node-codex" },
        { node: "node-unknown", usage: usage(10, 10) },
        { node: "node-codex", usage: { ...usage(10, 10), inputTokens: undefined } },
      ]),
    );
    expect(inputs.reportedTurns).toBe(0);
    expect(inputs.estimateEntries).toEqual([]);
  });
});

describe("combineThreadCost", () => {
  const reported = {
    reportedUsd: 1.2,
    reportedTurns: 3,
    reportedBy: "claudeAgent",
    estimateEntries: [],
  } as unknown as Parameters<typeof combineThreadCost>[0];
  const estimateOnly = {
    reportedUsd: 0,
    reportedTurns: 0,
    reportedBy: null,
    estimateEntries: [{ model: "gpt-5.5", totals: {} }],
  } as unknown as Parameters<typeof combineThreadCost>[0];

  it("labels a thread by where its cost came from", () => {
    expect(combineThreadCost(reported, null)).toMatchObject({ amountUsd: 1.2, source: "provider" });
    expect(combineThreadCost(estimateOnly, { costUsd: 0.5, unpricedModels: [] })).toMatchObject({
      amountUsd: 0.5,
      source: "estimate",
      partial: false,
    });
    expect(
      combineThreadCost(
        { ...reported, estimateEntries: estimateOnly.estimateEntries },
        { costUsd: 0.5, unpricedModels: ["gpt-5.5"] },
      ),
    ).toMatchObject({ amountUsd: 1.7, source: "mixed", partial: true });
  });

  it("shows nothing until there is something to show", () => {
    expect(combineThreadCost(estimateOnly, null)).toBeNull();
    expect(combineThreadCost({ ...reported, reportedTurns: 0, reportedUsd: 0 }, null)).toBeNull();
  });
});

describe("thread cost formatting", () => {
  it("formats the popover amount", () => {
    expect(formatThreadCost(1.391)).toBe("$1.39");
    expect(formatThreadCost(0)).toBe("$0.00");
    expect(formatThreadCost(0.004)).toBe("<$0.01");
  });

  it("keeps the badge short", () => {
    expect(formatThreadCostCompact(0.42)).toBe("$0.42");
    expect(formatThreadCostCompact(1.39)).toBe("$1.4");
    expect(formatThreadCostCompact(123.4)).toBe("$123");
  });
});

describe("threadCostSourceLabel", () => {
  const label = (driver: string) => (driver === "claudeAgent" ? "Claude" : undefined);
  const cost = {
    amountUsd: 1,
    source: "provider" as const,
    reportedBy: "claudeAgent" as never,
    partial: false,
  };

  it("names the reporting provider with the client's label", () => {
    expect(threadCostSourceLabel(cost, label)).toBe("reported by Claude");
    expect(threadCostSourceLabel({ ...cost, source: "mixed" }, label)).toBe(
      "reported by Claude + estimate",
    );
    expect(threadCostSourceLabel({ ...cost, reportedBy: null }, label)).toBe(
      "reported by provider",
    );
  });

  it("marks an estimate with unpriced models", () => {
    expect(threadCostSourceLabel({ ...cost, source: "estimate", partial: true }, label)).toBe(
      "estimate, some models unpriced",
    );
  });
});
