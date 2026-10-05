import {
  type EnvironmentId,
  type HttpUsageLimitSourceConfig,
  type UsageLimitSourceConfig,
  type UsageLimitSourceTestResult,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { formatMoney } from "@t3tools/shared/usageLimits";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { composeUsageSourceUrl, splitUsageSourceUrl } from "../../lib/usageSourceUrl";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

type SourceKind = "cliproxy" | "http";
type WindowKind = HttpUsageLimitSourceConfig["windowKind"];

/** LiteLLM's `/user/info` and `/key/info` shape, the most common gateway; editable per source. */
const LITELLM_FIELDS = {
  used: "spend",
  limit: "budget_table.max_budget",
  softLimit: "budget_table.soft_budget",
  resetsAt: "budget_table.budget_reset_at",
} as const;

const WINDOW_KINDS: Record<WindowKind, string> = {
  monthly: "Monthly",
  weekly: "Weekly",
  session: "Session",
  other: "Other",
};

/**
 * Stable per source and readable in settings.json. Dots and dashes in the
 * host are kept so `foo-bar.com` and `foo.bar.com` do not collide; anything
 * else (a port's colon, a path) is folded to a dash.
 */
function sourceIdFromUrl(kind: SourceKind, url: string): UsageLimitSourceId {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // Keep the raw text; the server reports the bad URL on its row.
  }
  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return UsageLimitSourceId.make(`${kind}-${slug || (kind === "http" ? "endpoint" : "hub")}`);
}

/** `$42.50 of $1,000.00 (4%) · soft $800.00 · resets Nov 1, 2026` */
function describeTestResult(result: UsageLimitSourceTestResult): string {
  const money = (amount: number) => formatMoney(amount, result.currency);
  return [
    `${money(result.used)} of ${money(result.limit)} (${Math.round(result.usedPercent)}%)`,
    result.softLimit === undefined ? null : `soft ${money(result.softLimit)}`,
    result.resetsAt
      ? `resets ${new Date(result.resetsAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`
      : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** The server's reason (`HTTP 403 Forbidden — check the auth header`), not a generic line. */
function failureMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Could not read the endpoint.";
}

/** A saved source opened for editing; its id stays the same even if the host changes. */
export interface EditedUsageLimitSource {
  readonly id: UsageLimitSourceId;
  readonly source: UsageLimitSourceConfig;
}

/**
 * Adds or edits a usage-limit source from provider settings on one
 * environment: a CLIProxyAPI hub, or any JSON endpoint reporting a spending
 * budget. The secret is sent once and kept in that server's secret store;
 * settings only ever carry a redaction marker for it afterwards. An edit left
 * with an empty secret sends that marker back, which keeps the stored one.
 */
export function AddUsageLimitSourceDialog({
  open,
  onOpenChange,
  environmentId,
  environmentLabel,
  editing,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly editing?: EditedUsageLimitSource;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const testSource = useAtomCommand(serverEnvironment.testUsageLimitSource, {
    reportFailure: false,
  });
  const saved = editing?.source;
  const savedHttp = saved?.kind === "http" ? saved : undefined;
  const [savedUrlParts] = useState(() =>
    savedHttp ? splitUsageSourceUrl(savedHttp.url) : { baseUrl: "", path: "", userId: "" },
  );
  const [kind, setKind] = useState<SourceKind>(saved?.kind ?? "cliproxy");
  const [label, setLabel] = useState(saved?.label ?? "");
  const [url, setUrl] = useState(saved?.kind === "cliproxy" ? saved.url : "");
  const [baseUrl, setBaseUrl] = useState(savedUrlParts.baseUrl);
  const [path, setPath] = useState(savedUrlParts.path);
  const [userId, setUserId] = useState(savedUrlParts.userId);
  const [managementKey, setManagementKey] = useState("");
  const [token, setToken] = useState("");
  const [headerName, setHeaderName] = useState(savedHttp?.authHeaderName ?? "");
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(savedHttp?.authHeaderName));
  const [usedField, setUsedField] = useState<string>(savedHttp?.fields.used ?? LITELLM_FIELDS.used);
  const [limitField, setLimitField] = useState<string>(
    savedHttp?.fields.limit ?? LITELLM_FIELDS.limit,
  );
  const [softLimitField, setSoftLimitField] = useState<string>(
    savedHttp ? (savedHttp.fields.softLimit ?? "") : LITELLM_FIELDS.softLimit,
  );
  const [resetsAtField, setResetsAtField] = useState<string>(
    savedHttp ? (savedHttp.fields.resetsAt ?? "") : LITELLM_FIELDS.resetsAt,
  );
  const [windowKind, setWindowKind] = useState<WindowKind>(savedHttp?.windowKind ?? "monthly");
  const [currency, setCurrency] = useState(savedHttp?.currency ?? "USD");
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<{
    readonly ok: boolean;
    readonly text: string;
  } | null>(null);
  const trimmedUrl =
    kind === "cliproxy" ? url.trim() : composeUsageSourceUrl({ baseUrl, path, userId });
  const hasUrl = kind === "cliproxy" ? trimmedUrl.length > 0 : baseUrl.trim().length > 0;
  const canSave =
    hasUrl &&
    (kind === "cliproxy"
      ? editing !== undefined || managementKey.trim().length > 0
      : usedField.trim().length > 0 && limitField.trim().length > 0);
  // Testing needs the secret, which the client never gets back after saving.
  const canTest = canSave && (editing === undefined || token.trim().length > 0);
  // The marker the server sent for the stored secret; echoing it keeps that secret.
  const savedSecret = saved ? (saved.kind === "http" ? saved.authHeader : saved.managementKey) : "";

  const reset = () => {
    setKind("cliproxy");
    setLabel("");
    setUrl("");
    setBaseUrl("");
    setPath("");
    setUserId("");
    setManagementKey("");
    setToken("");
    setHeaderName("");
    setAdvancedOpen(false);
    setUsedField(LITELLM_FIELDS.used);
    setLimitField(LITELLM_FIELDS.limit);
    setSoftLimitField(LITELLM_FIELDS.softLimit);
    setResetsAtField(LITELLM_FIELDS.resetsAt);
    setWindowKind("monthly");
    setCurrency("USD");
    setTestStatus(null);
  };

  const httpConfig = (): HttpUsageLimitSourceConfig => ({
    kind: "http",
    ...(label.trim() ? { label: label.trim() } : {}),
    url: trimmedUrl,
    authHeader: token.trim() || savedSecret,
    ...(headerName.trim() ? { authHeaderName: headerName.trim() } : {}),
    enabled: saved?.enabled ?? true,
    fields: {
      used: usedField.trim(),
      limit: limitField.trim(),
      ...(softLimitField.trim() ? { softLimit: softLimitField.trim() } : {}),
      ...(resetsAtField.trim() ? { resetsAt: resetsAtField.trim() } : {}),
    },
    currency: currency.trim().toUpperCase() || "USD",
    windowKind,
  });

  const test = async () => {
    if (!canTest || kind !== "http") return;
    setTesting(true);
    setTestStatus(null);
    const result = await testSource({ environmentId, input: httpConfig() });
    setTesting(false);
    setTestStatus(
      result._tag === "Success"
        ? { ok: true, text: describeTestResult(result.value) }
        : {
            ok: false,
            text: failureMessage(Cause.squash(result.cause)),
          },
    );
  };

  const save = () => {
    if (!canSave) return;
    const id = editing?.id ?? sourceIdFromUrl(kind, trimmedUrl);
    // The patch names only this entry; the server merges it into its map.
    updateSettings({
      usageLimitSources: {
        [id]:
          kind === "http"
            ? httpConfig()
            : {
                kind: "cliproxy",
                ...(label.trim() ? { label: label.trim() } : {}),
                url: trimmedUrl,
                managementKey: managementKey.trim() || savedSecret,
                enabled: saved?.enabled ?? true,
              },
      },
    });
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit usage source" : "Add a usage source"}</DialogTitle>
          <DialogDescription>
            {kind === "cliproxy"
              ? "Show the quota of every account a CLIProxyAPI hub pools"
              : "Show a spending budget an endpoint such as an LLM gateway reports"}
            , next to the providers on {environmentLabel}. The secret stays on that server.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            {editing ? null : (
              <ToggleGroup
                aria-label="Usage source type"
                variant="segmented"
                value={[kind]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "cliproxy" || value === "http") {
                    setKind(value);
                    setTestStatus(null);
                  }
                }}
              >
                <Toggle value="cliproxy">CLIProxyAPI hub</Toggle>
                <Toggle value="http">HTTP endpoint</Toggle>
              </ToggleGroup>
            )}
            {kind === "cliproxy" ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="usage-source-url">Hub URL</Label>
                  <Input
                    id="usage-source-url"
                    placeholder="https://hub.example.ts.net:8318"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    autoFocus
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="usage-source-key">Management key</Label>
                  <Input
                    id="usage-source-key"
                    type="password"
                    autoComplete="off"
                    placeholder={editing ? "Leave empty to keep the current key" : undefined}
                    value={managementKey}
                    onChange={(event) => setManagementKey(event.target.value)}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="usage-source-base-url">Base URL</Label>
                  <Input
                    id="usage-source-base-url"
                    placeholder="https://gateway.example.com"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    autoFocus
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="usage-source-path">Path</Label>
                    <Input
                      id="usage-source-path"
                      placeholder="/user/info"
                      value={path}
                      onChange={(event) => setPath(event.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="usage-source-user-id">User ID (optional)</Label>
                    <Input
                      id="usage-source-user-id"
                      value={userId}
                      onChange={(event) => setUserId(event.target.value)}
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  The user ID is sent as the <code>user_id</code> query param.
                </p>
                <div className="grid gap-1.5">
                  <Label htmlFor="usage-source-token">Token (optional)</Label>
                  <Input
                    id="usage-source-token"
                    type="password"
                    autoComplete="off"
                    placeholder={editing ? "Leave empty to keep the current token" : "sk-…"}
                    value={token}
                    onChange={(event) => {
                      setToken(event.target.value);
                      setTestStatus(null);
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    {headerName.trim() ? (
                      <>
                        Sent unchanged in the <code>{headerName.trim()}</code> header.
                      </>
                    ) : (
                      <>
                        Sent as <code>Authorization: Bearer &lt;token&gt;</code>.
                      </>
                    )}
                    {editing ? " Enter the token again to test the source." : ""}
                  </p>
                </div>
                <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                  <CollapsibleTrigger className="flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <ChevronRightIcon
                      className={advancedOpen ? "size-3 rotate-90" : "size-3"}
                      aria-hidden
                    />
                    Advanced
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <div className="grid gap-1.5 pt-2">
                      <Label htmlFor="usage-source-header-name">Header name (optional)</Label>
                      <Input
                        id="usage-source-header-name"
                        placeholder="x-api-key"
                        value={headerName}
                        onChange={(event) => setHeaderName(event.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        For gateways that take the token in another header, without{" "}
                        <code>Bearer</code>.
                      </p>
                    </div>
                  </CollapsiblePanel>
                </Collapsible>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="usage-source-used">Used</Label>
                    <Input
                      id="usage-source-used"
                      value={usedField}
                      onChange={(event) => setUsedField(event.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="usage-source-limit">Limit</Label>
                    <Input
                      id="usage-source-limit"
                      value={limitField}
                      onChange={(event) => setLimitField(event.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="usage-source-soft">Soft limit (optional)</Label>
                    <Input
                      id="usage-source-soft"
                      value={softLimitField}
                      onChange={(event) => setSoftLimitField(event.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="usage-source-resets">Resets at (optional)</Label>
                    <Input
                      id="usage-source-resets"
                      value={resetsAtField}
                      onChange={(event) => setResetsAtField(event.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Window</Label>
                    <Select
                      value={windowKind}
                      onValueChange={(value) => {
                        if (value && value in WINDOW_KINDS) setWindowKind(value as WindowKind);
                      }}
                    >
                      <SelectTrigger size="sm" aria-label="Budget window">
                        <SelectValue>
                          {(value: WindowKind | null) => (value ? WINDOW_KINDS[value] : "")}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {(Object.keys(WINDOW_KINDS) as WindowKind[]).map((value) => (
                          <SelectItem key={value} value={value}>
                            {WINDOW_KINDS[value]}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="usage-source-currency">Currency</Label>
                    <Input
                      id="usage-source-currency"
                      placeholder="USD"
                      value={currency}
                      onChange={(event) => setCurrency(event.target.value)}
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Fields are dot paths into the JSON response. The defaults match LiteLLM's{" "}
                  <code>/user/info</code>; change them for other gateways.
                </p>
              </>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-label">Label (optional)</Label>
              <Input
                id="usage-source-label"
                placeholder="Defaults to the host name"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            {testStatus ? (
              <p
                role="status"
                className={
                  testStatus.ok
                    ? "text-xs text-foreground tabular-nums"
                    : "text-xs text-destructive"
                }
              >
                {testStatus.ok ? "✓ " : ""}
                {testStatus.text}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          {kind === "http" ? (
            <Button
              variant="outline"
              className="me-auto"
              disabled={!canTest || testing}
              onClick={() => void test()}
            >
              {testing ? "Testing…" : "Test"}
            </Button>
          ) : null}
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {editing ? "Save" : kind === "cliproxy" ? "Add hub" : "Add source"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
