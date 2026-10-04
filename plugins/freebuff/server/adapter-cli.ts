import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ADAPTER_CLI } from "./generated";

const run = promisify(execFile);

const CLI_TIMEOUT_MS = 30_000;

interface CliFailure {
  stderr?: unknown;
  message?: unknown;
}

/** The adapter's own error line (it never contains secrets); falls back to a generic message. */
function failureMessage(error: unknown): string {
  const failure = (error ?? {}) as CliFailure;
  const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
  const lastLine = stderr.split("\n").findLast((line) => line.trim().length > 0);
  return lastLine ?? "Freebuff adapter command failed";
}

/**
 * Run an adapter CLI command that prints one JSON document. The handler
 * surfaces only the adapter's stderr line, never the raw exec error (which
 * would echo the whole command line).
 */
export async function runAdapterJson<T>(args: string[]): Promise<T> {
  try {
    const { stdout } = await run(process.execPath, [ADAPTER_CLI, ...args], {
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout) as T;
  } catch (error) {
    throw new Error(failureMessage(error), { cause: error });
  }
}
