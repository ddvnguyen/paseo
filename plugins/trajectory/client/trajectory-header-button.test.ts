/** Header-button registration and workspace reconciliation. */

import { describe, expect, it, vi } from "vitest";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import {
  registerTrajectoryHeaderButton,
  TRAJECTORY_HEADER_BUTTON_ID,
} from "./trajectory-header-button.js";

interface FakeButton {
  workspaceId: string;
  removed: boolean;
  onPress: () => void;
}

interface Harness {
  client: PluginClientContext;
  buttons: FakeButton[];
  opened: Array<{ id: string; options: unknown }>;
  emitSnapshot: (ids: string[]) => void;
  emitUpsert: (id: string) => void;
  emitRemove: (id: string) => void;
  failList: (error: unknown) => void;
}

function harness(options: { listRejects?: boolean } = {}): Harness {
  const buttons: FakeButton[] = [];
  const opened: Harness["opened"] = [];
  let observer: {
    snapshot: (value: { entries: Array<{ id: string }> }) => void;
    update: (message: unknown) => void;
  } | null = null;
  let rejectList: ((error: unknown) => void) | null = null;

  const client = {
    addHeaderButton: vi.fn((contribution) => {
      const button = contribution.button as {
        behavior: { kind: "action"; onPress: () => void };
      };
      const entry: FakeButton = {
        workspaceId: contribution.workspaceId,
        removed: false,
        onPress: button.behavior.onPress,
      };
      buttons.push(entry);
      return {
        update: vi.fn(),
        remove: () => {
          entry.removed = true;
        },
      };
    }),
    openPanel: vi.fn((id: string, openOptions: unknown) => {
      opened.push({ id, options: openOptions });
    }),
    paseo: {
      workspaces: {
        list: () =>
          options.listRejects
            ? new Promise((_resolve, reject) => {
                rejectList = reject;
              })
            : Promise.resolve({
                subscription: {
                  subscriptionId: "sub-1",
                  ready: Promise.resolve({ subscriptionId: "sub-1", entries: [] }),
                  subscribe: (next: typeof observer) => {
                    observer = next;
                    return () => {
                      observer = null;
                    };
                  },
                  release: vi.fn(),
                },
              }),
      },
    },
  } as unknown as PluginClientContext;

  return {
    client,
    buttons,
    opened,
    emitSnapshot: (ids) => observer?.snapshot({ entries: ids.map((id) => ({ id })) }),
    emitUpsert: (id) =>
      observer?.update({
        type: "workspace_update",
        payload: { kind: "upsert", workspace: { id } },
      }),
    emitRemove: (id) =>
      observer?.update({ type: "workspace_update", payload: { kind: "remove", id } }),
    failList: (error) => rejectList?.(error),
  };
}

/** Let the list() promise settle so the observer is attached. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("registerTrajectoryHeaderButton", () => {
  it("registers one button per workspace from the initial snapshot", async () => {
    const h = harness();
    registerTrajectoryHeaderButton(h.client);
    await settle();

    h.emitSnapshot(["w1", "w2"]);

    expect(h.buttons.map((b) => b.workspaceId)).toEqual(["w1", "w2"]);
  });

  it("uses the trajectory panel id and a resolvable Lucide icon", async () => {
    const h = harness();
    registerTrajectoryHeaderButton(h.client);
    await settle();
    h.emitSnapshot(["w1"]);

    const call = (h.client.addHeaderButton as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { id: string; button: { icon: string } };

    expect(call.id).toBe(TRAJECTORY_HEADER_BUTTON_ID);
    // resolvePluginIcon reflects over lucide-react-native, so a kebab-case name
    // would throw at contribution time.
    expect(call.button.icon).toBe("ListTree");
  });

  it("opens the dialog for its own workspace", async () => {
    const h = harness();
    registerTrajectoryHeaderButton(h.client);
    await settle();
    h.emitSnapshot(["w1", "w2"]);

    h.buttons[1].onPress();

    expect(h.opened).toEqual([
      { id: "trajectory", options: { workspaceId: "w2", location: "dialog" } },
    ]);
  });

  it("does not register a second button when a workspace is re-upserted", async () => {
    const h = harness();
    registerTrajectoryHeaderButton(h.client);
    await settle();
    h.emitSnapshot(["w1"]);

    h.emitUpsert("w1");

    // The host dedupes on (plugin, placement, id, workspace) and throws on a
    // duplicate, so a re-upsert must be a no-op.
    expect(h.buttons).toHaveLength(1);
  });

  it("adds a button for a workspace that appears later", async () => {
    const h = harness();
    registerTrajectoryHeaderButton(h.client);
    await settle();
    h.emitSnapshot(["w1"]);

    h.emitUpsert("w2");

    expect(h.buttons.map((b) => b.workspaceId)).toEqual(["w1", "w2"]);
  });

  it("removes the button when a workspace goes away", async () => {
    const h = harness();
    registerTrajectoryHeaderButton(h.client);
    await settle();
    h.emitSnapshot(["w1", "w2"]);

    h.emitRemove("w1");

    expect(h.buttons[0].removed).toBe(true);
    expect(h.buttons.filter((b) => !b.removed)).toHaveLength(1);
  });

  it("drops workspaces a later snapshot no longer lists", async () => {
    const h = harness();
    registerTrajectoryHeaderButton(h.client);
    await settle();
    h.emitSnapshot(["w1", "w2"]);

    h.emitSnapshot(["w2"]);

    expect(h.buttons.filter((b) => !b.removed).map((b) => b.workspaceId)).toEqual(["w2"]);
  });

  it("removes every button on cleanup", async () => {
    const h = harness();
    const cleanup = registerTrajectoryHeaderButton(h.client);
    await settle();
    h.emitSnapshot(["w1", "w2"]);

    cleanup();

    expect(h.buttons.every((b) => b.removed)).toBe(true);
  });

  it("ignores updates for other message types", async () => {
    const h = harness();
    registerTrajectoryHeaderButton(h.client);
    await settle();

    h.emitUpsert("w1");

    expect(h.buttons.map((b) => b.workspaceId)).toEqual(["w1"]);
  });

  it("survives a failed workspace list without throwing", async () => {
    const h = harness({ listRejects: true });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    registerTrajectoryHeaderButton(h.client);
    await settle();
    h.failList(new Error("daemon unreachable"));
    await settle();

    expect(h.buttons).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
