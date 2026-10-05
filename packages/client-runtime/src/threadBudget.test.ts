import type { UsageLimitSourceSnapshots } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadBudget } from "./threadBudget.ts";

const source = (kind: "http" | "cliproxy", windowKind = "monthly", spend = true) =>
  ({
    id: `${kind}-source`,
    kind,
    label: "Team gateway",
    checkedAt: "2026-10-03T00:00:00.000Z",
    accounts: [
      {
        id: "budget",
        driver: "claudeAgent",
        usageLimits: {
          checkedAt: "2026-10-03T00:00:00.000Z",
          windows: [
            {
              id: "budget:http-source",
              kind: windowKind,
              label: "Team gateway",
              usedPercent: 18,
              ...(spend
                ? {
                    spend: { usedMinor: 27548, limitMinor: 150000, currency: "USD", exponent: 2 },
                  }
                : {}),
            },
          ],
        },
      },
    ],
  }) as unknown as UsageLimitSourceSnapshots[number];

describe("threadBudget", () => {
  it("shows what is left of an HTTP source's budget", () => {
    expect(threadBudget([source("http")])).toEqual({
      label: "Monthly budget",
      amount: "$1,224.52 left of $1,500.00",
    });
  });

  it("names a budget with no calendar period by its source", () => {
    expect(threadBudget([source("http", "other")])?.label).toBe("Team gateway");
  });

  it("hides when no HTTP source reports a budget", () => {
    expect(threadBudget([])).toBeNull();
    expect(threadBudget([source("cliproxy")])).toBeNull();
    expect(threadBudget([source("http", "monthly", false)])).toBeNull();
  });
});
