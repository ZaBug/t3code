import {
  formatContextWindowPercentage,
  formatContextWindowTokens,
} from "@t3tools/client-runtime/context-window";
import { formatThreadCost, threadCostSourceLabel } from "@t3tools/client-runtime/thread-cost";
import type { EnvironmentId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Option from "effect/Option";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { useEnvironmentThread } from "../../state/threads";
import { useThreadUsage } from "./useThreadUsage";

type UsageTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

const DRIVER_LABEL: Partial<Record<string, string>> = {
  antigravity: "Antigravity",
  claudeAgent: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
};
const driverLabel = (driver: ProviderDriverKind) => DRIVER_LABEL[driver];

/**
 * The thread's context window, cost, and gateway budget: the details web shows
 * in the composer's context popover. Opened from the thread header subtitle on
 * Android; the device's "Show thread cost" setting hides the money rows.
 */
export function ThreadUsageSheet({ route }: StaticScreenProps<UsageTarget>) {
  const target = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const thread = useEnvironmentThread(target.environmentId, target.threadId);
  const { context, cost, budget } = useThreadUsage({
    environmentId: target.environmentId,
    threadId: target.threadId,
    projection: Option.getOrNull(thread.data),
  });
  const usedPercentage = context ? formatContextWindowPercentage(context.usedPercentage) : null;
  const totalProcessed = context?.totalProcessedTokens ?? null;
  const maxTokens = context?.maxTokens ?? null;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AndroidSheetHeader title="Thread usage" onBack={() => navigation.goBack()} />
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-5 pt-2"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
      >
        {context === null && cost === null && budget === null ? (
          <Text className="pt-6 text-center text-sm text-foreground-muted">
            No usage reported yet.
          </Text>
        ) : null}
        {context ? (
          <UsageRow
            label="Context window"
            value={
              maxTokens !== null && usedPercentage
                ? `${usedPercentage} · ${formatContextWindowTokens(context.usedTokens)}/${formatContextWindowTokens(maxTokens)}`
                : formatContextWindowTokens(context.usedTokens)
            }
          />
        ) : null}
        {totalProcessed !== null && totalProcessed > 0 ? (
          <UsageRow label="Total processed" value={formatContextWindowTokens(totalProcessed)} />
        ) : null}
        {cost ? (
          <UsageRow
            label="Thread cost"
            detail={threadCostSourceLabel(cost, driverLabel)}
            value={formatThreadCost(cost.amountUsd)}
          />
        ) : null}
        {budget ? <UsageRow label={budget.label} value={budget.amount} /> : null}
      </ScrollView>
    </View>
  );
}

function UsageRow(props: {
  readonly label: string;
  readonly detail?: string;
  readonly value: string;
}) {
  return (
    <View className="flex-row items-center justify-between gap-4 border-b border-border-subtle py-3.5">
      <View className="min-w-0 flex-1">
        <Text className="text-base text-foreground">{props.label}</Text>
        {props.detail ? (
          <Text className="text-sm text-foreground-muted">{props.detail}</Text>
        ) : null}
      </View>
      <Text className="font-t3-medium text-base tabular-nums text-foreground">{props.value}</Text>
    </View>
  );
}
