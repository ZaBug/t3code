import {
  type EnvironmentId,
  type HttpUsageLimitSourceConfig,
  type UsageLimitSourceTestResult,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { formatMoney } from "@t3tools/shared/usageLimits";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
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

/**
 * Adds a usage-limit source from provider settings on one environment: a
 * CLIProxyAPI hub, or any JSON endpoint reporting a spending budget. The
 * secret is sent once and kept in that server's secret store; settings only
 * ever carry a redaction marker for it afterwards.
 */
export function AddUsageLimitSourceDialog({
  open,
  onOpenChange,
  environmentId,
  environmentLabel,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const testSource = useAtomCommand(serverEnvironment.testUsageLimitSource, {
    reportFailure: false,
  });
  const [kind, setKind] = useState<SourceKind>("cliproxy");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [managementKey, setManagementKey] = useState("");
  const [authHeader, setAuthHeader] = useState("");
  const [usedField, setUsedField] = useState("");
  const [limitField, setLimitField] = useState("");
  const [softLimitField, setSoftLimitField] = useState("");
  const [resetsAtField, setResetsAtField] = useState("");
  const [windowKind, setWindowKind] = useState<WindowKind>("monthly");
  const [currency, setCurrency] = useState("USD");
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<{
    readonly ok: boolean;
    readonly text: string;
  } | null>(null);
  const trimmedUrl = url.trim();
  const canSave =
    trimmedUrl.length > 0 &&
    (kind === "cliproxy"
      ? managementKey.trim().length > 0
      : usedField.trim().length > 0 && limitField.trim().length > 0);

  const reset = () => {
    setKind("cliproxy");
    setLabel("");
    setUrl("");
    setManagementKey("");
    setAuthHeader("");
    setUsedField("");
    setLimitField("");
    setSoftLimitField("");
    setResetsAtField("");
    setWindowKind("monthly");
    setCurrency("USD");
    setTestStatus(null);
  };

  const httpConfig = (): HttpUsageLimitSourceConfig => ({
    kind: "http",
    ...(label.trim() ? { label: label.trim() } : {}),
    url: trimmedUrl,
    authHeader: authHeader.trim(),
    enabled: true,
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
    if (!canSave || kind !== "http") return;
    setTesting(true);
    setTestStatus(null);
    const result = await testSource({ environmentId, input: httpConfig() });
    setTesting(false);
    setTestStatus(
      result._tag === "Success"
        ? { ok: true, text: describeTestResult(result.value) }
        : {
            ok: false,
            text:
              "error" in result.cause && result.cause.error instanceof Error
                ? result.cause.error.message
                : "Could not read the endpoint.",
          },
    );
  };

  const save = () => {
    if (!canSave) return;
    const id = sourceIdFromUrl(kind, trimmedUrl);
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
                managementKey: managementKey.trim(),
                enabled: true,
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
          <DialogTitle>Add a usage source</DialogTitle>
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
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-url">{kind === "cliproxy" ? "Hub URL" : "URL"}</Label>
              <Input
                id="usage-source-url"
                placeholder={
                  kind === "cliproxy"
                    ? "https://hub.example.ts.net:8318"
                    : "https://gateway.example.com/user/info"
                }
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                autoFocus
              />
            </div>
            {kind === "cliproxy" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="usage-source-key">Management key</Label>
                <Input
                  id="usage-source-key"
                  type="password"
                  autoComplete="off"
                  value={managementKey}
                  onChange={(event) => setManagementKey(event.target.value)}
                />
              </div>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="usage-source-auth">Auth header (optional)</Label>
                  <Input
                    id="usage-source-auth"
                    type="password"
                    autoComplete="off"
                    placeholder="Bearer sk-… or x-api-key: sk-…"
                    value={authHeader}
                    onChange={(event) => setAuthHeader(event.target.value)}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="usage-source-used">Used</Label>
                    <Input
                      id="usage-source-used"
                      placeholder="spend"
                      value={usedField}
                      onChange={(event) => setUsedField(event.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="usage-source-limit">Limit</Label>
                    <Input
                      id="usage-source-limit"
                      placeholder="budget_table.max_budget"
                      value={limitField}
                      onChange={(event) => setLimitField(event.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="usage-source-soft">Soft limit (optional)</Label>
                    <Input
                      id="usage-source-soft"
                      placeholder="budget_table.soft_budget"
                      value={softLimitField}
                      onChange={(event) => setSoftLimitField(event.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="usage-source-resets">Resets at (optional)</Label>
                    <Input
                      id="usage-source-resets"
                      placeholder="budget_table.budget_reset_at"
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
                  Fields are dot paths into the JSON response, such as{" "}
                  <code>budget_table.max_budget</code>.
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
              disabled={!canSave || testing}
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
            {kind === "cliproxy" ? "Add hub" : "Add source"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
