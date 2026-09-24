import { spawn } from "node:child_process";
import path from "node:path";

import type { CodebuffClient } from "@codebuff/sdk";

/**
 * Abortable replacement for the SDK's built-in `run_terminal_command`.
 *
 * The SDK's own implementation ignores the run's AbortSignal, so a stopped
 * turn would sit on a long-running command until it finished or timed out.
 * This override kills the command's whole process group when the active turn
 * is aborted, which lets the SDK run unwind promptly.
 */

type OverrideTools = NonNullable<ConstructorParameters<typeof CodebuffClient>[0]["overrideTools"]>;
type RunTerminalCommand = NonNullable<OverrideTools["run_terminal_command"]>;

/** The turn a command runs on behalf of (turns are serialized process-wide). */
export interface ActiveTurnContext {
  cwd: string;
  signal: AbortSignal;
}

const OUTPUT_LIMIT_CHARS = 20_000;
const KILL_ESCALATION_MS = 2_000;

/** Keep the head and tail of oversized output (the middle is rarely useful). */
function truncateMiddle(text: string): string {
  if (text.length <= OUTPUT_LIMIT_CHARS) return text;
  const half = Math.floor(OUTPUT_LIMIT_CHARS / 2);
  return `${text.slice(0, half)}\n[... output truncated ...]\n${text.slice(-half)}`;
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    // Negative pid targets the process group created by `detached: true`.
    process.kill(-pid, signal);
  } catch {
    // Already exited.
  }
}

export function createAbortableTerminalTool(
  getActiveTurn: () => ActiveTurnContext | null,
): RunTerminalCommand {
  return (input) =>
    new Promise((resolve, reject) => {
      if (input.process_type === "BACKGROUND") {
        reject(new Error("BACKGROUND process_type not implemented"));
        return;
      }
      const turn = getActiveTurn();
      const baseCwd = turn?.cwd ?? process.cwd();
      const signal = turn?.signal;
      if (signal?.aborted) {
        reject(new Error("Command cancelled"));
        return;
      }

      const child = spawn("bash", ["-c", input.command], {
        cwd: path.resolve(baseCwd, input.cwd ?? "."),
        env: process.env,
        stdio: "pipe",
        detached: true,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let escalationTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(escalationTimer);
        signal?.removeEventListener("abort", onAbort);
        settle();
      };

      const terminate = () => {
        killProcessGroup(child.pid, "SIGTERM");
        escalationTimer = setTimeout(
          () => killProcessGroup(child.pid, "SIGKILL"),
          KILL_ESCALATION_MS,
        );
        escalationTimer.unref?.();
      };

      function onAbort() {
        terminate();
        finish(() => reject(new Error("Command cancelled")));
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      const timeoutSeconds = input.timeout_seconds;
      if (typeof timeoutSeconds === "number" && timeoutSeconds >= 0) {
        timeoutTimer = setTimeout(() => {
          terminate();
          finish(() => reject(new Error(`Command timed out after ${timeoutSeconds} seconds`)));
        }, timeoutSeconds * 1000);
      }

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        finish(() => reject(new Error(`Failed to spawn command: ${error.message}`)));
      });
      child.on("close", (exitCode) => {
        finish(() =>
          resolve([
            {
              type: "json",
              value: {
                command: input.command,
                stdout: truncateMiddle(stdout),
                ...(stderr ? { stderr: truncateMiddle(stderr) } : {}),
                ...(exitCode !== null ? { exitCode } : {}),
              },
            },
          ]),
        );
      });
    });
}
