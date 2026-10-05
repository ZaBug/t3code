import { describe, expect, it } from "vite-plus/test";

import { composeUsageSourceUrl, splitUsageSourceUrl } from "./usageSourceUrl";

const GATEWAY =
  "https://api.llm-incubator.automotive.cloud/prod/v0/platform/user-info/llm-usage-details";

describe("splitUsageSourceUrl", () => {
  it("separates the origin, the path, and the user ID", () => {
    expect(splitUsageSourceUrl(`${GATEWAY}?user_id=uid123`)).toEqual({
      baseUrl: "https://api.llm-incubator.automotive.cloud",
      path: "/prod/v0/platform/user-info/llm-usage-details",
      userId: "uid123",
    });
  });

  it("leaves the user ID empty when the URL has none", () => {
    expect(splitUsageSourceUrl("https://gateway.test/user/info")).toEqual({
      baseUrl: "https://gateway.test",
      path: "/user/info",
      userId: "",
    });
  });

  it("keeps other query params on the path", () => {
    expect(splitUsageSourceUrl("https://gateway.test:8443/info?team=a&user_id=me&x=1")).toEqual({
      baseUrl: "https://gateway.test:8443",
      path: "/info?team=a&x=1",
      userId: "me",
    });
  });

  it("keeps a URL that does not parse whole", () => {
    expect(splitUsageSourceUrl("not a url")).toEqual({
      baseUrl: "not a url",
      path: "",
      userId: "",
    });
  });
});

describe("composeUsageSourceUrl", () => {
  it("adds the user ID as a query param", () => {
    expect(
      composeUsageSourceUrl({
        baseUrl: "https://api.llm-incubator.automotive.cloud",
        path: "/prod/v0/platform/user-info/llm-usage-details",
        userId: "uid123",
      }),
    ).toBe(`${GATEWAY}?user_id=uid123`);
  });

  it("sends no user_id param when the user ID is empty", () => {
    expect(
      composeUsageSourceUrl({ baseUrl: "https://gateway.test", path: "/user/info", userId: " " }),
    ).toBe("https://gateway.test/user/info");
  });

  it("forgives a trailing slash on the base and a missing slash on the path", () => {
    expect(
      composeUsageSourceUrl({ baseUrl: "https://gateway.test/", path: "user/info", userId: "me" }),
    ).toBe("https://gateway.test/user/info?user_id=me");
  });

  it("keeps other query params next to the user ID", () => {
    expect(
      composeUsageSourceUrl({
        baseUrl: "https://gateway.test",
        path: "/info?team=a",
        userId: "me",
      }),
    ).toBe("https://gateway.test/info?team=a&user_id=me");
  });

  it("round-trips a saved URL", () => {
    const url = "https://gateway.test/info?team=a&user_id=me";
    expect(composeUsageSourceUrl(splitUsageSourceUrl(url))).toBe(url);
  });

  it("keeps an invalid base as typed", () => {
    expect(composeUsageSourceUrl({ baseUrl: "gateway", path: "info", userId: "a b" })).toBe(
      "gateway/info?user_id=a%20b",
    );
  });
});
