/** The parts an HTTP usage source's URL is edited as; settings keep the whole URL. */
export interface UsageSourceUrlParts {
  readonly baseUrl: string;
  readonly path: string;
  readonly userId: string;
}

const USER_ID_PARAM = "user_id";

/**
 * Splits a saved URL into the origin, the path with any other query params,
 * and the `user_id` param. A URL that does not parse stays whole in `baseUrl`
 * so the form still shows what was saved.
 */
export function splitUsageSourceUrl(url: string): UsageSourceUrlParts {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { baseUrl: url, path: "", userId: "" };
  }
  const userId = parsed.searchParams.get(USER_ID_PARAM) ?? "";
  parsed.searchParams.delete(USER_ID_PARAM);
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
  return { baseUrl: parsed.origin, path: `${pathname}${parsed.search}${parsed.hash}`, userId };
}

/**
 * Joins the parts back into the URL settings store. A trailing slash on the
 * base or a missing leading slash on the path is forgiven, and an empty user
 * ID sends no `user_id` param.
 */
export function composeUsageSourceUrl(parts: UsageSourceUrlParts): string {
  const base = parts.baseUrl.trim().replace(/\/+$/, "");
  let path = parts.path.trim();
  if (path.length > 0 && !/^[/?#]/.test(path)) path = `/${path}`;
  const userId = parts.userId.trim();
  const joined = `${base}${path}`;
  if (userId.length === 0) return joined;
  try {
    const parsed = new URL(joined);
    parsed.searchParams.set(USER_ID_PARAM, userId);
    return parsed.toString();
  } catch {
    // Kept as typed; the server reports the bad URL on the source's row.
    const separator = joined.includes("?") ? "&" : "?";
    return `${joined}${separator}${USER_ID_PARAM}=${encodeURIComponent(userId)}`;
  }
}
