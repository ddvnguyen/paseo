import type { RpcOutput } from "@getpaseo/plugin";

import type { freebuffStatus } from "../shared/status";
import { runAdapterJson } from "./adapter-cli";

/** Quota per account and model check, via the adapter CLI (tokens never leave it). */
export function readFreebuffStatus(): Promise<RpcOutput<typeof freebuffStatus>> {
  return runAdapterJson(["status"]);
}
