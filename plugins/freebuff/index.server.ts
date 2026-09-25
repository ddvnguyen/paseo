import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";

import {
  cancelLogin,
  deleteAccount,
  endSession,
  listAccounts,
  pollLogin,
  renameAccount,
  setAccountDefault,
  startLogin,
} from "./server/accounts";
import { ADAPTER_ENTRY } from "./server/generated";
import { readFreebuffStatus } from "./server/status";
import {
  freebuffAccountDelete,
  freebuffAccountRename,
  freebuffAccountsList,
  freebuffAccountSetDefault,
  freebuffLoginCancel,
  freebuffLoginPoll,
  freebuffLoginStart,
  freebuffSessionEnd,
} from "./shared/accounts";
import { freebuffStatus } from "./shared/status";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(
    runAcpProvider({
      // Not "freebuff": hosts that already configure a `freebuff` provider by
      // hand (agents.providers.freebuff) reject a plugin provider with that id
      // and the whole plugin fails to start, taking the settings screen with it.
      id: "freebuff-plugin",
      label: "Freebuff (plugin)",
      description: "Free coding models via Freebuff, with multi-account quota",
      icon: "icon.svg",
      command: [process.execPath, ADAPTER_ENTRY],
    }),
  );
  server.handle(freebuffStatus, readFreebuffStatus);
  server.handle(freebuffAccountsList, listAccounts);
  server.handle(freebuffLoginStart, startLogin);
  server.handle(freebuffLoginPoll, pollLogin);
  server.handle(freebuffLoginCancel, cancelLogin);
  server.handle(freebuffAccountDelete, deleteAccount);
  server.handle(freebuffAccountSetDefault, setAccountDefault);
  server.handle(freebuffAccountRename, renameAccount);
  server.handle(freebuffSessionEnd, endSession);
  return () => {};
}
