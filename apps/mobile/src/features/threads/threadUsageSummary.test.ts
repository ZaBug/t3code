import { describe, expect, it } from "vite-plus/test";

import { threadHeaderSubtitle } from "./threadUsageSummary";

const base = {
  projectTitle: "t3code",
  environmentLabel: "TMDADM1W",
  costUsd: 1.39,
  contextUsedPercentage: 32.4,
  showCost: true,
};

describe("threadHeaderSubtitle", () => {
  it("appends the compact cost and the context share", () => {
    expect(threadHeaderSubtitle(base)).toBe("t3code · TMDADM1W · $1.4 · 32%");
  });

  it("leaves out a cost or context share it does not know", () => {
    expect(threadHeaderSubtitle({ ...base, costUsd: null })).toBe("t3code · TMDADM1W · 32%");
    expect(threadHeaderSubtitle({ ...base, contextUsedPercentage: null })).toBe(
      "t3code · TMDADM1W · $1.4",
    );
  });

  it("hides only the cost when the setting is off", () => {
    expect(threadHeaderSubtitle({ ...base, showCost: false })).toBe("t3code · TMDADM1W · 32%");
  });

  it("formats small amounts and shares like the desktop badge", () => {
    expect(threadHeaderSubtitle({ ...base, costUsd: 0.004, contextUsedPercentage: 4.25 })).toBe(
      "t3code · TMDADM1W · <$0.01 · 4.3%",
    );
  });

  it("keeps the project and environment when nothing else is known", () => {
    expect(threadHeaderSubtitle({ ...base, costUsd: null, contextUsedPercentage: null })).toBe(
      "t3code · TMDADM1W",
    );
    expect(
      threadHeaderSubtitle({
        ...base,
        projectTitle: null,
        costUsd: null,
        contextUsedPercentage: null,
      }),
    ).toBe("TMDADM1W");
  });
});
