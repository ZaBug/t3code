import { describe, expect, it } from "@effect/vitest";

import {
  claudeTurnReportedCost,
  initialClaudeReportedCost,
  type ClaudeReportedCostState,
} from "./ClaudeTurnTokenUsage.ts";

/** Feeds results through one process's state and returns each turn's share. */
function shares(
  results: ReadonlyArray<{ uuid: string; total_cost_usd?: unknown }>,
  state: ClaudeReportedCostState = initialClaudeReportedCost,
) {
  const out: Array<number | undefined> = [];
  let current = state;
  for (const result of results) {
    const next = claudeTurnReportedCost(current, result);
    current = next.state;
    out.push(next.turnCostUsd);
  }
  return out;
}

describe("claudeTurnReportedCost", () => {
  it("turns the running total into per-turn shares that sum back to it", () => {
    const turns = shares([
      { uuid: "a", total_cost_usd: 0.25 },
      { uuid: "b", total_cost_usd: 0.4 },
      { uuid: "c", total_cost_usd: 1.4 },
    ]);
    expect(turns[0]).toBeCloseTo(0.25);
    expect(turns[1]).toBeCloseTo(0.15);
    expect(turns[2]).toBeCloseTo(1);
    expect(turns.reduce((sum, turn) => sum! + turn!, 0)).toBeCloseTo(1.4);
  });

  it("counts a resumed process from zero, since its total starts fresh", () => {
    const first = shares([{ uuid: "a", total_cost_usd: 2 }]);
    // A new CLI process gets a new state, as the adapter keeps one per query.
    const resumed = shares([
      { uuid: "b", total_cost_usd: 0.3 },
      { uuid: "c", total_cost_usd: 0.5 },
    ]);
    expect([...first, ...resumed].reduce((sum, turn) => sum! + turn!, 0)).toBeCloseTo(2.5);
  });

  it("treats a lower total in the same process as a reset (/clear)", () => {
    const turns = shares([
      { uuid: "a", total_cost_usd: 1 },
      { uuid: "b", total_cost_usd: 0.2 },
      { uuid: "c", total_cost_usd: 0.5 },
    ]);
    expect(turns[1]).toBeCloseTo(0.2);
    expect(turns[2]).toBeCloseTo(0.3);
  });

  it("keeps a replayed result's first share instead of reporting zero", () => {
    const turns = shares([
      { uuid: "a", total_cost_usd: 0.5 },
      { uuid: "b", total_cost_usd: 0.8 },
      { uuid: "b", total_cost_usd: 0.8 },
    ]);
    expect(turns[2]).toBeCloseTo(0.3);
  });

  it("reports nothing for a result without a usable total and keeps the state", () => {
    const turns = shares([
      { uuid: "a", total_cost_usd: 0.5 },
      { uuid: "b" },
      { uuid: "c", total_cost_usd: Number.NaN },
      { uuid: "d", total_cost_usd: 0.7 },
    ]);
    expect(turns[1]).toBeUndefined();
    expect(turns[2]).toBeUndefined();
    expect(turns[3]).toBeCloseTo(0.2);
  });
});
