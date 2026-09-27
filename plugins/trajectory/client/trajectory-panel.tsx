import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginAgentPanelProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import type { TrajectoryCellProps } from "../shared/dsh/record.js";
import { LedgerScreen } from "./ledger-screen.js";
import { TrajectoryInspector } from "./trajectory-inspector.js";
import { useTrajectoryDelta } from "./use-trajectory-delta.js";

export type TrajectoryPanelProps = PluginAgentPanelProps | PluginWorkspacePanelProps;

type AgentSelection =
  | { status: "loading" }
  | { status: "ready"; agentId: string }
  | { status: "empty" }
  | { status: "error"; error: string };

/**
 * Trajectory panel root. Agent-context opens carry their agentId;
 * workspace-context opens auto-select the workspace's first agent via
 * `paseo.agents.list` (entries are `{agent, project}`; filter client-side on
 * `agent.workspaceId` — fetch_agents has no workspace filter). Rows come
 * from the settle-driven delta loop (list once, changes on settle,
 * frame-coalesced); the ledger underneath is the dsh-parity screen (folds,
 * tail-follow only at bottom, compact tags, in-flight "—").
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

  return <LiveLedger agentId={selection.agentId} compact={layout.compact} theme={theme} />;
}

/**
 * Live ledger for one agent. Split so the delta hook runs unconditionally
 * for a fixed agentId (no conditional-hook lint/ordering hazard in the
 * selection branch above). Loading shows a notice; errors keep the last
 * rows with a retry kick (the loop parks on error — no timers, no auto
 * retry — so manual refresh is the only recovery).
 */
function LiveLedger(props: { agentId: string; compact: boolean; theme: PluginTheme }) {
  const { agentId, compact, theme } = props;
  const delta = useTrajectoryDelta(agentId);
  // Selected row seq (null = inspector closed, the default). Seq — not the
  // row object — so live updates refresh the inspector content in place; a
  // selection whose row left the window resolves to null and closes it.
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);

  useEffect(() => {
    setSelectedSeq(null);
  }, [agentId]);

  const onCellPress = useCallback((cell: TrajectoryCellProps) => {
    if (cell.sourceSeq !== undefined) setSelectedSeq(cell.sourceSeq);
  }, []);

  const onCloseInspector = useCallback(() => {
    setSelectedSeq(null);
  }, []);

  if (delta.status === "loading") {
    return (
      <PanelNotice theme={theme} testID="trajectory-panel-loading" message="loading trajectory…" />
    );
  }

  const selectedRow =
    selectedSeq === null ? null : (delta.rows.find((row) => row.seq === selectedSeq) ?? null);

  return (
    <View style={panelStyles(theme)} testID="trajectory-panel">
      <View style={captionRowStyles()}>
        <Text style={captionStyles(theme)} testID="trajectory-panel-agent">
          trajectory · {agentId}
        </Text>
        {delta.status === "error" ? (
          <Pressable
            accessibilityRole="button"
            onPress={delta.refresh}
            testID="trajectory-panel-retry"
          >
            <Text style={retryStyles(theme)}>retry</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={bodyStyles()}>
        <View style={ledgerStyles()}>
          <LedgerScreen
            rows={delta.rows}
            compact={compact}
            theme={theme}
            onCellPress={onCellPress}
          />
        </View>
        {/* Wide dock takes layout space; compact overlays (absolute fill). */}
        {selectedRow === null || compact ? null : <View style={dockSpacerStyles()} />}
        <TrajectoryInspector
          row={selectedRow}
          compact={compact}
          theme={theme}
          onClose={onCloseInspector}
        />
      </View>
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

// Plain style objects (not StyleSheet.create): these carry dynamic theme
// values and react-native-web's create only accepts named-style dicts —
// a flat object throws inside its WeakMap cache on web.
function panelStyles(theme: PluginTheme): ViewStyle {
  return {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  };
}

function captionRowStyles(): ViewStyle {
  return {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    paddingVertical: 4,
  };
}

function bodyStyles(): ViewStyle {
  return {
    flex: 1,
    flexDirection: "row",
  };
}

function ledgerStyles(): ViewStyle {
  return {
    flex: 1,
  };
}

function dockSpacerStyles(): ViewStyle {
  return {
    width: 320,
  };
}

function retryStyles(theme: PluginTheme): TextStyle {
  return {
    color: theme.colors.foregroundMuted,
    fontSize: 11,
  };
}

function captionStyles(theme: PluginTheme): TextStyle {
  return {
    color: theme.colors.foregroundMuted,
    fontSize: 11,
    paddingHorizontal: 8,
    paddingVertical: 4,
  };
}
