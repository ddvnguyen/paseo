// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi, type Mock } from "vitest";
import { useWorkspaceTerminals } from "./use-workspace-terminals";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/data/query", () => ({
  useReplicaQuery: () => ({ data: { terminals: [] }, dataUpdatedAt: 0 }),
}));

vi.mock("@/data/push-router", () => ({
  workspaceTerminalsPushRoute: () => ({}),
}));
function createClient(createTerminalImpl: (...args: unknown[]) => Promise<unknown>) {
  return { createTerminal: vi.fn(createTerminalImpl) };
}
function setup(initialIsConnected: boolean, client: { createTerminal: Mock }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const callbacks = {
    onTerminalCreated: vi.fn(),
    onScriptTerminalSelected: vi.fn(),
    onWorkspacePathUnavailable: vi.fn(),
    onTerminalCreateQueued: vi.fn(),
    onTerminalCreateFailed: vi.fn(),
  };
  const input = {
    client: client as never,
    isConnected: initialIsConnected,
    isRouteFocused: true,
    normalizedServerId: "server-1",
    normalizedWorkspaceId: "ws-1",
    workspaceDirectory: "/repo/ws-1",
    workspaceScripts: [],
    hasHydratedWorkspaces: true,
    isMissingWorkspaceDirectory: false,
    ...callbacks,
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const rendered = renderHook(
    ({ isConnected }) => useWorkspaceTerminals({ ...input, isConnected }),
    {
      initialProps: { isConnected: initialIsConnected },
      wrapper,
    },
  );
  return { ...rendered, callbacks, queryClient };
}

describe("useWorkspaceTerminals reconnect retry", () => {
  it("replays a failed create once the connection drops and recovers", async () => {
    const client = createClient(async () => ({ terminal: { id: "term-1" } }));
    client.createTerminal.mockRejectedValueOnce(new Error("stale socket"));
    const { result, rerender, callbacks } = setup(true, client);

    await act(async () => {
      result.current.createTerminal({ destination: { kind: "open" } });
    });
    expect(client.createTerminal).toHaveBeenCalledTimes(1);
    expect(callbacks.onTerminalCreateFailed).toHaveBeenCalledTimes(1);
    expect(callbacks.onTerminalCreated).not.toHaveBeenCalled();

    // Still connected: no retry on rerender alone.
    rerender({ isConnected: true });
    expect(client.createTerminal).toHaveBeenCalledTimes(1);

    // Disconnect then reconnect replays the held input exactly once.
    rerender({ isConnected: false });
    rerender({ isConnected: true });
    await act(async () => {});
    expect(client.createTerminal).toHaveBeenCalledTimes(2);
    expect(callbacks.onTerminalCreated).toHaveBeenCalledWith({
      terminalId: "term-1",
      destination: { kind: "open" },
    });

    // A later reconnect does not spawn a duplicate.
    rerender({ isConnected: false });
    rerender({ isConnected: true });
    await act(async () => {});
    expect(client.createTerminal).toHaveBeenCalledTimes(2);
  });

  it("does not retry a failure when the connection never dropped", async () => {
    const client = createClient(async () => ({ terminal: null, error: "no such profile" }));
    const { result, rerender, callbacks } = setup(true, client);

    await act(async () => {
      result.current.createTerminal({ destination: { kind: "open" } });
    });
    expect(callbacks.onTerminalCreateFailed).toHaveBeenCalledWith("no such profile");

    rerender({ isConnected: true });
    await act(async () => {});
    expect(client.createTerminal).toHaveBeenCalledTimes(1);
  });

  it("lets a fresh explicit create supersede the held failure", async () => {
    const client = createClient(async () => ({ terminal: { id: "term-2" } }));
    client.createTerminal.mockRejectedValueOnce(new Error("stale socket"));
    const { result, rerender, callbacks } = setup(true, client);

    await act(async () => {
      result.current.createTerminal({ destination: { kind: "open" } });
    });
    expect(client.createTerminal).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.createTerminal({ destination: { kind: "open", paneId: "pane-9" } });
    });
    expect(client.createTerminal).toHaveBeenCalledTimes(2);

    rerender({ isConnected: false });
    rerender({ isConnected: true });
    await act(async () => {});
    expect(client.createTerminal).toHaveBeenCalledTimes(2);
    expect(callbacks.onTerminalCreated).toHaveBeenCalledWith({
      terminalId: "term-2",
      destination: { kind: "open", paneId: "pane-9" },
    });
  });
});
