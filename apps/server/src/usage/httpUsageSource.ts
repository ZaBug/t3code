import {
  ProviderDriverKind,
  UsageLimitSourceError,
  type HttpUsageLimitSourceConfig,
  type UsageLimitSourceAccount,
  type UsageLimitSourceTestResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

/**
 * The value at a dot path (`budget_table.max_budget`, `data.0.spend`), or
 * undefined when any segment is missing. Numeric segments index arrays.
 */
export function resolveJsonPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Gateways report money as JSON numbers or decimal strings (`"42.50"`). */
function toAmount(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** ISO strings, or epoch seconds/milliseconds as some gateways report them. */
function toResetsAt(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const input = typeof value === "number" && value < 1e12 ? value * 1000 : value;
  return Option.getOrUndefined(Option.map(DateTime.make(input), DateTime.formatIso));
}

/**
 * The fields a mapping names, read from one response. Required fields must be
 * present; optional ones may be missing or null (a budget with no reset
 * reports `null`) but must parse when present. Errors name the path.
 */
export function parseHttpUsage(
  config: Pick<HttpUsageLimitSourceConfig, "fields" | "currency">,
  body: unknown,
): Result.Result<UsageLimitSourceTestResult, string> {
  const amount = (path: string, required: boolean) => {
    const raw = resolveJsonPath(body, path);
    if (raw === undefined || raw === null) {
      return required ? Result.fail(`${path} not found`) : Result.succeed(undefined);
    }
    const value = toAmount(raw);
    if (value === undefined) return Result.fail(`${path} is not a number`);
    if (value < 0) return Result.fail(`${path} is negative`);
    return Result.succeed(value);
  };
  const used = amount(config.fields.used, true);
  if (Result.isFailure(used)) return Result.fail(used.failure);
  const limit = amount(config.fields.limit, true);
  if (Result.isFailure(limit)) return Result.fail(limit.failure);
  if (limit.success === 0) return Result.fail(`${config.fields.limit} is zero`);
  const softLimit = config.fields.softLimit
    ? amount(config.fields.softLimit, false)
    : Result.succeed(undefined);
  if (Result.isFailure(softLimit)) return Result.fail(softLimit.failure);
  let resetsAt: string | undefined;
  if (config.fields.resetsAt) {
    const raw = resolveJsonPath(body, config.fields.resetsAt);
    if (raw !== undefined && raw !== null) {
      resetsAt = toResetsAt(raw);
      if (resetsAt === undefined) return Result.fail(`${config.fields.resetsAt} is not a date`);
    }
  }
  const usedValue = used.success!;
  const limitValue = limit.success!;
  return Result.succeed({
    used: usedValue,
    limit: limitValue,
    ...(softLimit.success === undefined ? {} : { softLimit: softLimit.success }),
    currency: config.currency,
    usedPercent: Math.min(100, Math.max(0, (usedValue / limitValue) * 100)),
    ...(resetsAt ? { resetsAt } : {}),
  });
}

/** Digits after the decimal point for a currency: 2 for USD, 0 for JPY. */
function currencyExponent(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/**
 * The single account an `http` source publishes. Gateway budgets are most
 * often what Claude Code runs behind (`ANTHROPIC_BASE_URL`), so the account
 * lists under Claude; the window id carries the source id so two gateways
 * never pool into one bar.
 */
export function httpUsageAccount(input: {
  readonly sourceId: string;
  readonly label: string;
  readonly config: Pick<HttpUsageLimitSourceConfig, "windowKind">;
  readonly reading: UsageLimitSourceTestResult;
  readonly checkedAt: string;
}): UsageLimitSourceAccount {
  const { reading } = input;
  const exponent = currencyExponent(reading.currency);
  const scale = 10 ** exponent;
  return {
    id: "budget",
    driver: ProviderDriverKind.make("claudeAgent"),
    usageLimits: {
      checkedAt: input.checkedAt,
      windows: [
        {
          id: `budget:${input.sourceId}`,
          kind: input.config.windowKind,
          label: input.label,
          usedPercent: reading.usedPercent,
          ...(reading.resetsAt ? { resetsAt: reading.resetsAt } : {}),
          spend: {
            usedMinor: Math.round(reading.used * scale),
            limitMinor: Math.round(reading.limit * scale),
            currency: reading.currency,
            exponent,
          },
        },
      ],
    },
  };
}

/** `Name: value` sends a named header; anything else is the `Authorization` value. */
export function authHeaderEntry(authHeader: string): readonly [string, string] | null {
  if (authHeader.length === 0) return null;
  const named = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):\s*(.+)$/.exec(authHeader);
  return named ? [named[1]!, named[2]!] : ["Authorization", authHeader];
}

export const makeHttpUsageSource = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const read = Effect.fn("HttpUsageSource.read")(function* (
    config: HttpUsageLimitSourceConfig,
  ): Effect.fn.Return<UsageLimitSourceTestResult, UsageLimitSourceError> {
    const url = yield* Effect.try({
      try: () => {
        const parsed = new URL(config.url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
        return parsed.toString();
      },
      catch: () => new UsageLimitSourceError({ detail: "The source URL is not valid." }),
    });
    const header = authHeaderEntry(config.authHeader);
    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.acceptJson,
      header ? HttpClientRequest.setHeader(header[0], header[1]) : (request) => request,
    );
    const body = yield* client.execute(request).pipe(
      Effect.mapError(() => new UsageLimitSourceError({ detail: "The source request failed." })),
      Effect.flatMap((response) =>
        response.status < 200 || response.status >= 300
          ? Effect.fail(
              new UsageLimitSourceError({
                detail: `The source answered HTTP ${response.status}.`,
              }),
            )
          : response.json.pipe(
              Effect.mapError(
                () => new UsageLimitSourceError({ detail: "The source did not return JSON." }),
              ),
            ),
      ),
      Effect.timeout("15 seconds"),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(new UsageLimitSourceError({ detail: "The source did not answer in time." })),
      ),
    );
    const parsed = parseHttpUsage(config, body);
    if (Result.isFailure(parsed)) {
      return yield* new UsageLimitSourceError({ detail: parsed.failure });
    }
    return parsed.success;
  });

  return { read };
});
