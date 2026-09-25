import type { RpcInput, RpcOutput } from "@getpaseo/plugin";

import type {
  freebuffAccountDelete,
  freebuffAccountsList,
  freebuffLoginCancel,
  freebuffLoginPoll,
  freebuffLoginStart,
  freebuffSessionEnd,
} from "../shared/accounts";
import { runAdapterJson } from "./adapter-cli";

export function listAccounts(): Promise<RpcOutput<typeof freebuffAccountsList>> {
  return runAdapterJson(["accounts", "list"]);
}

export function startLogin({
  id,
  label,
}: RpcInput<typeof freebuffLoginStart>): Promise<RpcOutput<typeof freebuffLoginStart>> {
  return runAdapterJson([
    "accounts",
    "login-start",
    "--id",
    id,
    ...(label ? ["--label", label] : []),
  ]);
}

export function pollLogin({
  id,
}: RpcInput<typeof freebuffLoginPoll>): Promise<RpcOutput<typeof freebuffLoginPoll>> {
  return runAdapterJson(["accounts", "login-poll", "--id", id]);
}

export function cancelLogin({
  id,
}: RpcInput<typeof freebuffLoginCancel>): Promise<RpcOutput<typeof freebuffLoginCancel>> {
  return runAdapterJson(["accounts", "login-cancel", "--id", id]);
}

export function deleteAccount({
  id,
}: RpcInput<typeof freebuffAccountDelete>): Promise<RpcOutput<typeof freebuffAccountDelete>> {
  return runAdapterJson(["accounts", "delete", "--id", id]);
}

export function endSession({
  id,
}: RpcInput<typeof freebuffSessionEnd>): Promise<RpcOutput<typeof freebuffSessionEnd>> {
  return runAdapterJson(["session", "end", "--id", id]);
}
