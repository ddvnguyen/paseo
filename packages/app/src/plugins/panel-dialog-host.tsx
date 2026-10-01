import { useMemo } from "react";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import type {
  PluginAgentPanelProps,
  PluginHostProps,
  PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceExists } from "@/stores/session-store-hooks";
import type { Theme } from "@/styles/theme";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { usePluginHostNavigation } from "./host-navigation";
import { createPluginClientStateSource } from "./client-state/source";
import { toPluginTheme } from "./theme";
import { useInstalledPlugin } from "./registry";
import { PluginRuntimeBoundary } from "./runtime-boundary";
import { SurfaceErrorBoundary } from "./surface-error-boundary";
import {
  closePluginPanelDialog,
  subscribePluginPanelDialog,
  getPluginPanelDialogSnapshot,
  type PluginPanelDialogState,
} from "./dialog-store";

/**
 * Host for `location: "dialog"` plugin panels (P1: the trajectory ledger).
 * Renders the single open dialog per workspace inside AdaptiveModalSheet —
 * a full modal overlay, never a workspace tab. The workspace screen mounts
 * <PluginPanelDialogHost /> once; props are assembled exactly like
 * workspace-panels/panel.tsx assembles tab panels, minus the pane machinery.
 */

const pluginThemeMapping = (theme: Theme) => ({
  theme: toPluginTheme(theme),
});

function resolvePlatform(): PluginHostProps["layout"]["platform"] {
  if (Platform.OS === "ios") return "ios";
  if (Platform.OS === "android") return "android";
  return "web";
}

function agentExistsInWorkspace(
  state: Parameters<Parameters<typeof useSessionStore>[0]>[0],
  serverId: string,
  agentId: string,
  workspaceId: string,
): boolean {
  const session = state.sessions[serverId];
  const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
  return (
    Boolean(agent) &&
    normalizeWorkspaceOpaqueId(agent?.workspaceId) === normalizeWorkspaceOpaqueId(workspaceId)
  );
}

interface ResolvedPluginPanelDialog {
  dialog: PluginPanelDialogState;
  serverId: string;
  workspaceId: string;
  plugin: NonNullable<ReturnType<typeof useInstalledPlugin>>;
  contribution: NonNullable<ReturnType<typeof useInstalledPlugin>>["workspacePanels"][number];
  client: NonNullable<ReturnType<typeof useHostRuntimeClient>>;
  agentExists: boolean | null;
  compact: boolean;
  host: { id: string; label: string };
  layout: { compact: boolean; platform: PluginHostProps["layout"]["platform"] };
  stateSource: ReturnType<typeof createPluginClientStateSource>;
  navigation: ReturnType<typeof usePluginHostNavigation>;
}

function useResolvedPluginPanelDialog(): ResolvedPluginPanelDialog | null {
  const dialog = useSyncExternalStore(subscribePluginPanelDialog, getPluginPanelDialogSnapshot);
  const serverId = dialog?.serverId ?? "";
  const workspaceId = dialog?.workspaceId ?? "";
  const panelId = dialog?.panelId ?? "";
  const dialogContext = dialog?.context ?? "workspace";
  const dialogAgentId = dialog?.agentId;
  const plugin = useInstalledPlugin(serverId, panelId);
  const contribution = useMemo(
    () =>
      plugin?.workspacePanels.find(
        (candidate) => candidate.id === panelId && candidate.context === dialogContext,
      ) ?? null,
    [plugin, panelId, dialogContext],
  );
  const workspaceExists = useWorkspaceExists(serverId, workspaceId);
  const agentExists = useSessionStore((state) => {
    if (dialogContext !== "agent" || dialogAgentId === undefined) return null;
    return agentExistsInWorkspace(state, serverId, dialogAgentId, workspaceId);
  });
  const client = useHostRuntimeClient(serverId);
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const host = useMemo(() => ({ id: serverId, label: hostLabel }), [hostLabel, serverId]);
  const layout = useMemo(() => ({ compact, platform: resolvePlatform() }), [compact]);
  const stateSource = useMemo(() => createPluginClientStateSource(serverId), [serverId]);
  const navigation = usePluginHostNavigation(serverId);

  if (!dialog || !contribution || !plugin || !workspaceExists || !client) {
    return null;
  }
  return {
    dialog,
    serverId,
    workspaceId,
    plugin,
    contribution,
    client,
    agentExists,
    compact,
    host,
    layout,
    stateSource,
    navigation,
  };
}

function PluginPanelDialogBody({ theme }: { theme: PluginTheme }) {
  const resolved = useResolvedPluginPanelDialog();
  if (!resolved) {
    return null;
  }
  const { dialog, serverId, workspaceId, plugin, contribution, client } = resolved;
  const { agentExists, host, layout, navigation, stateSource } = resolved;

  let panel;
  let Surface: unknown;
  if (contribution.context === "workspace") {
    const props: PluginWorkspacePanelProps = {
      context: "workspace",
      theme,
      host,
      layout,
      navigation,
      onClosePanel: closePluginPanelDialog,
      workspaceId,
    };
    Surface = contribution.Component;
    panel = <contribution.Component {...props} />;
  } else if (agentExists === true && dialog.context === "agent") {
    const props: PluginAgentPanelProps = {
      context: "agent",
      theme,
      host,
      layout,
      navigation,
      onClosePanel: closePluginPanelDialog,
      workspaceId,
      agentId: dialog.agentId ?? "",
    };
    Surface = contribution.Component;
    panel = <contribution.Component {...props} />;
  } else {
    return null;
  }

  return (
    <PluginPanelSheet
      onClose={closePluginPanelDialog}
      fullScreen={contribution.fullScreen === true}
    >
      <SurfaceErrorBoundary
        installation={plugin}
        Surface={Surface}
        key={`${serverId}/${dialog.pluginId}/${dialog.panelId}/${dialog.context}/${dialog.agentId ?? ""}`}
      >
        <PluginRuntimeBoundary plugin={plugin} client={client}>
          <PluginClientStateProvider source={stateSource}>{panel}</PluginClientStateProvider>
        </PluginRuntimeBoundary>
      </SurfaceErrorBoundary>
    </PluginPanelSheet>
  );
}

/**
 * Width ceiling for a full-screen dialog. The desktop card is `width: 100%` and
 * the overlay already pads it, so this only has to be wider than any viewport we
 * target — the padding is then the only thing constraining the card. A panel that
 * does not opt in keeps AdaptiveModalSheet's own 520pt ceiling.
 */
const FULL_SCREEN_MAX_WIDTH = 2400;

/**
 * Header for a plugin panel dialog: close control, no text.
 *
 * `edgeToEdge` is what actually decides the shape of this dialog — the bar is
 * suppressed outright and AdaptiveModalSheet floats the close control over the
 * content at the top right, so the plugin surface starts flush at 0,0. The
 * header object stays because the prop is required, and its title is never
 * rendered in this mode.
 *
 * Module constant, so the header object is never reallocated per render.
 */
const NO_TITLE_HEADER = { title: "" };

/** Sheet wrapper owning the header object and the stable snap points. */
function PluginPanelSheet(props: {
  onClose: () => void;
  fullScreen: boolean;
  children: React.ReactNode;
}) {
  const { onClose, fullScreen, children } = props;
  // Static per mode, so the arrays/values are module constants rather than fresh
  // objects on every render.
  const fullScreenSnapPoints = useMemo(() => ["100%"], []);
  return (
    <AdaptiveModalSheet
      header={NO_TITLE_HEADER}
      visible
      onClose={onClose}
      // Caller-owned FlatList body (ledger): the host must not own scrolling.
      scrollable={false}
      bodyStyle={styles.body}
      // The plugin surface owns its own padding and draws full bleed, so the
      // sheet's content inset must not sit on top of it. It also owns a close
      // control in its own chrome — a toolbar X, say — which is why the sheet's
      // own control stands down on wide. Compact keeps it: a full-screen sheet
      // starts at 0,0, so the surface's own close is where the status bar is.
      edgeToEdge
      surfaceOwnsClose
      desktopHeight={fullScreen ? "100%" : undefined}
      desktopMaxWidth={fullScreen ? FULL_SCREEN_MAX_WIDTH : undefined}
      snapPoints={fullScreen ? fullScreenSnapPoints : undefined}
      testID="plugin-panel-dialog"
    >
      {children}
    </AdaptiveModalSheet>
  );
}

const ThemedPluginPanelDialogBody = withUnistyles(PluginPanelDialogBody);

/**
 * Mount once per workspace screen; renders nothing while no dialog is open.
 *
 * The active check is load-bearing, not a nicety. The workspace deck keeps
 * inactive workspaces MOUNTED (RetainedPanel) and merely hides them with
 * `display: "none"`. AdaptiveModalSheet portals its content to the global
 * overlay root on web, which escapes that hidden wrapper — so an inactive
 * screen's host still put a real, visible dialog on screen, and one open
 * stacked two identical dialogs. Reading the retained-panel context means each
 * host renders only while its own workspace is the active one.
 *
 * The context defaults to true, so a mount outside a RetainedPanel (and the
 * app's own test hosts) behaves exactly as before.
 */
function PluginPanelDialogHost() {
  const active = useRetainedPanelActive();
  if (!active) return null;
  return <ThemedPluginPanelDialogBody uniProps={pluginThemeMapping} />;
}

const styles = StyleSheet.create((theme) => ({
  body: {
    backgroundColor: theme.colors.surface0,
  },
}));

export { PluginPanelDialogHost };
