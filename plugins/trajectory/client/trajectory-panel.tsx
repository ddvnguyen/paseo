import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginAgentPanelProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { LedgerScreen } from "./ledger-screen.js";
import { FIXTURE_ROWS } from "./fixtures.js";

export type TrajectoryPanelProps = PluginAgentPanelProps | PluginWorkspacePanelProps;

type AgentSelection =
  | { status: "loading" }
  | { status: "ready"; agentId: string }
  | { status: "empty" }
  | { status: "error"; error: string };

/**
 * Trajectory panel root (T2 shell). Agent-context opens carry their agentId;
 * workspace-context opens auto-select the workspace's first agent via
 * `paseo.agents.list` (entries are `{agent, project}`; filter client-side on
 * `agent.workspaceId` — fetch_agents has no workspace filter). Rows are
 * fixtures until the T2.4 delta loop lands; the ledger underneath is the real
 * dsh-parity screen (folds, tail-follow, compact tags).
 */
export function TrajectoryPanel(props: TrajectoryPanelProps) {
  const { theme, layout } = props;
  const selection = useTrajectoryAgent(props);

  if (selection.status !== "ready") {
    return (
      <PanelNotice
        theme={theme}
        testID="trajectory-panel-notice"
        message={noticeMessage(selection)}
      />
    );
  }

  return (
    <View style={panelStyles(theme)} testID="trajectory-panel">
      <Text style={captionStyles(theme)} testID="trajectory-panel-agent">
        trajectory · {selection.agentId}
      </Text>
      <LedgerScreen rows={FIXTURE_ROWS} compact={layout.compact} theme={theme} />
    </View>
  );
}

function useTrajectoryAgent(props: TrajectoryPanelProps): AgentSelection {
  const paseo = usePaseo();
  const [selection, setSelection] = useState<AgentSelection>(() =>
    props.context === "agent" ? { status: "ready", agentId: props.agentId } : { status: "loading" },
  );

  useEffect(() => {
    if (props.context === "agent") {
      setSelection({ status: "ready", agentId: props.agentId });
      return;
    }
    let cancelled = false;
    setSelection({ status: "loading" });
    void (async () => {
      try {
        const result = await paseo.agents.list();
        if (cancelled) return;
        const match = result.entries.find((entry) => entry.agent.workspaceId === props.workspaceId);
        setSelection(
          match === undefined ? { status: "empty" } : { status: "ready", agentId: match.agent.id },
        );
      } catch (error) {
        if (cancelled) return;
        setSelection({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paseo, props]);

  return selection;
}

function noticeMessage(selection: Exclude<AgentSelection, { status: "ready" }>): string {
  if (selection.status === "loading") return "finding trajectory…";
  if (selection.status === "empty") return "no agents in this workspace yet";
  return `trajectory unavailable: ${selection.error}`;
}

function PanelNotice(props: { theme: PluginTheme; testID: string; message: string }) {
  const { theme, testID, message } = props;
  return (
    <View style={panelStyles(theme)} testID={testID}>
      <Text style={captionStyles(theme)}>{message}</Text>
    </View>
  );
}

function panelStyles(theme: PluginTheme) {
  return StyleSheet.create({
    flex: 1,
    backgroundColor: theme.colors.surface0,
  });
}

function captionStyles(theme: PluginTheme) {
  return StyleSheet.create({
    color: theme.colors.foregroundMuted,
    fontSize: 11,
    paddingHorizontal: 8,
    paddingVertical: 4,
  });
}
