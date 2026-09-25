import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { RpcOutput } from "@getpaseo/plugin";

import type { freebuffStatus } from "../shared/status";
import { ADAPTER_CLI } from "./generated";

const run = promisify(execFile);

/** Quota per account and model check, via the adapter CLI (tokens never leave it). */
export async function readFreebuffStatus(): Promise<RpcOutput<typeof freebuffStatus>> {
  const { stdout } = await run(process.execPath, [ADAPTER_CLI, "status"], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout) as RpcOutput<typeof freebuffStatus>;
}
