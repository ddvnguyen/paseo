import { describe, expect, it } from "vitest";

import { createAbortableTerminalTool } from "./terminal.js";

function run(
  tool: ReturnType<typeof createAbortableTerminalTool>,
  input: { command: string; timeout_seconds?: number },
) {
  return tool({ process_type: "SYNC", ...input } as never);
}

describe("createAbortableTerminalTool", () => {
  it("returns stdout and exit code", async () => {
    const tool = createAbortableTerminalTool(() => ({
      cwd: "/tmp",
      signal: new AbortController().signal,
    }));
    const [result] = (await run(tool, { command: "echo hi; exit 3" })) as Array<{
      value: { stdout: string; exitCode: number };
    }>;
    expect(result?.value.stdout).toBe("hi\n");
    expect(result?.value.exitCode).toBe(3);
  });

  it("kills the running command and rejects promptly when the turn is aborted", async () => {
    const controller = new AbortController();
    const tool = createAbortableTerminalTool(() => ({ cwd: "/tmp", signal: controller.signal }));
    const started = Date.now();
    const pending = run(tool, { command: "sleep 30" });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow(/cancelled/i);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("rejects without spawning when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const tool = createAbortableTerminalTool(() => ({ cwd: "/tmp", signal: controller.signal }));
    await expect(run(tool, { command: "echo nope" })).rejects.toThrow(/cancelled/i);
  });

  it("enforces timeout_seconds", async () => {
    const tool = createAbortableTerminalTool(() => ({
      cwd: "/tmp",
      signal: new AbortController().signal,
    }));
    await expect(run(tool, { command: "sleep 30", timeout_seconds: 0.1 })).rejects.toThrow(
      /timed out/i,
    );
  });
});
