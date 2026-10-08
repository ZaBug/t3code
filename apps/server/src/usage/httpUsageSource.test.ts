import { describe, expect, it } from "@effect/vitest";
import type { HttpUsageLimitSourceConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import {
  authHeaderEntry,
  httpStatusDetail,
  httpUsageAccount,
  makeHttpUsageSource,
  parseHttpUsage,
  requestAuthHeader,
  requestFailureDetail,
  resolveJsonPath,
} from "./httpUsageSource.ts";

const gatewayResponse = {
  spend: 42.5,
  budget_table: {
    soft_budget: 800.0,
    max_budget: 1000.0,
    budget_duration: "1mo",
    budget_reset_at: "2026-11-01T00:00:00Z",
  },
  status: "success",
};

const config: HttpUsageLimitSourceConfig = {
  kind: "http",
  url: "https://gateway.test/user/info?user_id=me",
  authHeader: "Bearer gateway-secret",
  enabled: true,
  fields: {
    used: "spend",
    limit: "budget_table.max_budget",
    softLimit: "budget_table.soft_budget",
    resetsAt: "budget_table.budget_reset_at",
  },
  currency: "USD",
  windowKind: "monthly",
};

function fixture(respond: () => Response = () => Response.json(gatewayResponse)) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({ url: request.url, headers: { ...request.headers } });
      return HttpClientResponse.fromWeb(request, respond());
    }),
  );
  return {
    requests,
    source: makeHttpUsageSource.pipe(Effect.provideService(HttpClient.HttpClient, http)),
  };
}

const failureOf = (body: unknown, fields: Partial<HttpUsageLimitSourceConfig["fields"]> = {}) => {
  const result = parseHttpUsage({ ...config, fields: { ...config.fields, ...fields } }, body);
  return Result.isFailure(result) ? result.failure : null;
};

describe("resolveJsonPath", () => {
  it("follows nested keys and array indices", () => {
    expect(resolveJsonPath(gatewayResponse, "budget_table.max_budget")).toBe(1000);
    expect(resolveJsonPath({ data: [{ spend: 3 }] }, "data.0.spend")).toBe(3);
  });

  it("is undefined for a missing segment or a non-object along the way", () => {
    expect(resolveJsonPath(gatewayResponse, "budget_table.missing")).toBeUndefined();
    expect(resolveJsonPath(gatewayResponse, "spend.value")).toBeUndefined();
    expect(resolveJsonPath(gatewayResponse, "toString")).toBeUndefined();
  });
});

describe("parseHttpUsage", () => {
  it("maps the gateway fields to amounts, percent, and reset time", () => {
    expect(parseHttpUsage(config, gatewayResponse)).toEqual(
      Result.succeed({
        used: 42.5,
        limit: 1000,
        softLimit: 800,
        currency: "USD",
        usedPercent: 4.25,
        resetsAt: "2026-11-01T00:00:00.000Z",
      }),
    );
  });

  it("accepts decimal strings and epoch-second resets", () => {
    const result = parseHttpUsage(config, {
      spend: "1250.00",
      budget_table: { max_budget: "1000", budget_reset_at: 1793491200 },
    });
    expect(result).toEqual(
      Result.succeed({
        used: 1250,
        limit: 1000,
        currency: "USD",
        usedPercent: 100,
        resetsAt: "2026-11-01T00:00:00.000Z",
      }),
    );
  });

  it("leaves out optional fields the response reports as null", () => {
    const result = parseHttpUsage(config, {
      spend: 0,
      budget_table: { max_budget: 10, soft_budget: null, budget_reset_at: null },
    });
    expect(result).toEqual(Result.succeed({ used: 0, limit: 10, currency: "USD", usedPercent: 0 }));
  });

  it("names the path that is missing or malformed", () => {
    expect(failureOf({ spend: 1 })).toBe("budget_table.max_budget not found");
    expect(failureOf({ ...gatewayResponse, spend: "lots" })).toBe("spend is not a number");
    expect(failureOf({ ...gatewayResponse, spend: -1 })).toBe("spend is negative");
    expect(failureOf({ spend: 1, budget_table: { max_budget: 0 } })).toBe(
      "budget_table.max_budget is zero",
    );
    expect(
      failureOf({ ...gatewayResponse, budget_table: { max_budget: 1, soft_budget: "x" } }),
    ).toBe("budget_table.soft_budget is not a number");
    expect(
      failureOf({ ...gatewayResponse, budget_table: { max_budget: 1, budget_reset_at: "soon" } }),
    ).toBe("budget_table.budget_reset_at is not a date");
  });
});

describe("httpUsageAccount", () => {
  it("publishes one budget window with amounts in the currency's minor units", () => {
    const reading = Result.getOrThrow(parseHttpUsage(config, gatewayResponse));
    const account = httpUsageAccount({
      sourceId: "http-gateway.test",
      label: "Team gateway",
      config,
      reading,
      checkedAt: "2026-10-03T00:00:00.000Z",
    });
    expect(account.driver).toBe("claudeAgent");
    expect(account.usageLimits.windows).toEqual([
      {
        id: "budget:http-gateway.test",
        kind: "monthly",
        label: "Team gateway",
        usedPercent: 4.25,
        resetsAt: "2026-11-01T00:00:00.000Z",
        spend: { usedMinor: 4250, limitMinor: 100000, currency: "USD", exponent: 2 },
      },
    ]);
  });
});

describe("authHeaderEntry", () => {
  it("sends a value with a scheme as Authorization and a named header as written", () => {
    expect(authHeaderEntry("Bearer sk-1:2")).toEqual(["Authorization", "Bearer sk-1:2"]);
    expect(authHeaderEntry("Basic dXNlcjpwYXNz")).toEqual(["Authorization", "Basic dXNlcjpwYXNz"]);
    expect(authHeaderEntry("x-api-key: sk-1")).toEqual(["x-api-key", "sk-1"]);
    expect(authHeaderEntry("")).toBeNull();
  });

  it("sends a bare token as a Bearer token", () => {
    expect(authHeaderEntry("sk-abc123")).toEqual(["Authorization", "Bearer sk-abc123"]);
  });
});

describe("requestAuthHeader", () => {
  it("sends the token unchanged in a named header", () => {
    expect(requestAuthHeader({ authHeader: "sk-1", authHeaderName: "x-api-key" })).toEqual([
      "x-api-key",
      "sk-1",
    ]);
  });

  it("reads a source saved without a header name as before", () => {
    expect(requestAuthHeader({ authHeader: "sk-1" })).toEqual(["Authorization", "Bearer sk-1"]);
    expect(requestAuthHeader({ authHeader: "Bearer sk-1" })).toEqual([
      "Authorization",
      "Bearer sk-1",
    ]);
    expect(requestAuthHeader({ authHeader: "x-api-key: sk-1" })).toEqual(["x-api-key", "sk-1"]);
    expect(requestAuthHeader({ authHeader: "", authHeaderName: "x-api-key" })).toBeNull();
  });
});

describe("HTTP usage source", () => {
  it.effect("reads the endpoint with the stored auth header", () =>
    Effect.gen(function* () {
      const test = fixture();
      const source = yield* test.source;
      const reading = yield* source.read(config);
      expect(reading.usedPercent).toBe(4.25);
      expect(test.requests).toHaveLength(1);
      expect(test.requests[0]?.url).toBe(config.url);
      expect(test.requests[0]?.headers.authorization).toBe("Bearer gateway-secret");
    }),
  );

  it.effect("adds the Bearer scheme to a saved bare token", () =>
    Effect.gen(function* () {
      const test = fixture();
      const source = yield* test.source;
      yield* source.read({ ...config, authHeader: "gateway-secret" });
      expect(test.requests[0]?.headers.authorization).toBe("Bearer gateway-secret");
    }),
  );

  it.effect("sends the token in the named header without a scheme", () =>
    Effect.gen(function* () {
      const test = fixture();
      const source = yield* test.source;
      yield* source.read({ ...config, authHeader: "gateway-secret", authHeaderName: "x-api-key" });
      expect(test.requests[0]?.headers["x-api-key"]).toBe("gateway-secret");
      expect(test.requests[0]?.headers.authorization).toBeUndefined();
    }),
  );

  it.effect("reports the status and never the response body when the gateway refuses", () =>
    Effect.gen(function* () {
      const test = fixture(() => Response.json({ token: "do-not-publish" }, { status: 401 }));
      const source = yield* test.source;
      const error = yield* source.read(config).pipe(Effect.flip);
      expect(error.detail).toBe("HTTP 401 Unauthorized — check the auth header");
    }),
  );

  it.effect("reports a body that is not JSON", () =>
    Effect.gen(function* () {
      const test = fixture(() => new Response("<html>login</html>"));
      const source = yield* test.source;
      const error = yield* source.read(config).pipe(Effect.flip);
      expect(error.detail).toBe("The source did not return JSON.");
    }),
  );

  it.effect("reports the failing path as the source error", () =>
    Effect.gen(function* () {
      const test = fixture(() => Response.json({ spend: 1 }));
      const source = yield* test.source;
      const error = yield* source.read(config).pipe(Effect.flip);
      expect(error.detail).toBe("budget_table.max_budget not found");
    }),
  );

  it.effect("rejects a URL that is not http(s) without sending anything", () =>
    Effect.gen(function* () {
      const test = fixture();
      const source = yield* test.source;
      const error = yield* source.read({ ...config, url: "file:///etc/passwd" }).pipe(Effect.flip);
      expect(error.detail).toBe("The source URL is not valid.");
      expect(test.requests).toHaveLength(0);
    }),
  );
});

describe("failure details", () => {
  it("names the status and what to check", () => {
    expect(httpStatusDetail(403)).toBe("HTTP 403 Forbidden — check the auth header");
    expect(httpStatusDetail(404)).toBe("HTTP 404 Not Found — check the URL");
    expect(httpStatusDetail(502)).toBe("HTTP 502 Bad Gateway");
    expect(httpStatusDetail(599)).toBe("HTTP 599");
  });

  it("reports the innermost network cause rather than fetch's generic message", () => {
    const reason = {
      cause: new TypeError("fetch failed", { cause: new Error("self-signed certificate") }),
    };
    expect(requestFailureDetail(reason)).toBe(
      "Could not reach the source: self-signed certificate",
    );
    expect(requestFailureDetail({})).toBe("Could not reach the source.");
  });

  it.effect("surfaces a transport failure through the reader", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new TypeError("fetch failed", {
                cause: new Error("getaddrinfo ENOTFOUND gateway.test"),
              }),
            }),
          }),
        ),
      );
      const source = yield* makeHttpUsageSource.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const error = yield* source.read(config).pipe(Effect.flip);
      expect(error.detail).toBe("Could not reach the source: getaddrinfo ENOTFOUND gateway.test");
      expect(error.detail).not.toContain("gateway-secret");
    }),
  );
});
