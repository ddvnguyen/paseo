/**
 * Convert ACP session MCP servers + `.agents/mcp.json` into the Codebuff
 * SDK's `AgentDefinition.mcpServers` map (stdio / http / sse).
 *
 * ACP ships servers as an array (`session/new`); Codebuff wants a named
 * record. Host-injected servers (e.g. Paseo's `paseo` MCP) win over file
 * config on name collision.
 *
 * File discovery mirrors loadMCPConfig: `{cwd}/.agents/mcp.json`,
 * `{cwd}/../.agents/mcp.json`, `{homedir}/.agents/mcp.json` — but uses the
 * ACP session cwd (not process.cwd()), which may differ under a host.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { McpServer as AcpMcpServer } from "@agentclientprotocol/sdk";

/** Codebuff MCP config shape (MCPConfig is not exported from the SDK). */
export type CodebuffMcpConfig =
  | {
      type?: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      type?: "http" | "sse";
      url: string;
      params?: Record<string, string>;
      headers?: Record<string, string>;
    };

type AcpEnv = Array<{ name: string; value: string }>;
type AcpHeader = Array<{ name: string; value: string }>;
interface RawMcpFile {
  mcpServers?: Record<string, unknown>;
}

function envArrayToRecord(env: AcpEnv | undefined): Record<string, string> | undefined {
  if (!env || env.length === 0) return undefined;
  const record: Record<string, string> = {};
  for (const { name, value } of env) {
    if (name) record[name] = value;
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

function headersArrayToRecord(headers: AcpHeader | undefined): Record<string, string> | undefined {
  return envArrayToRecord(headers);
}

/** ACP McpServer → Codebuff MCPConfig (same transport shapes). */
export function acpServerToCodebuffConfig(server: AcpMcpServer): CodebuffMcpConfig | null {
  if ("command" in server && server.command) {
    const env = envArrayToRecord(server.env);
    return {
      type: "stdio",
      command: server.command,
      args: server.args ?? [],
      ...(env ? { env } : {}),
    };
  }
  if ("url" in server && server.url) {
    const headers = headersArrayToRecord(server.headers);
    if (server.type === "sse") {
      return { type: "sse", url: server.url, ...(headers ? { headers } : {}) };
    }
    if (server.type === "http" || !("command" in server)) {
      return { type: "http", url: server.url, ...(headers ? { headers } : {}) };
    }
  }
  return null;
}

function isCodebuffMcpConfig(value: unknown): value is CodebuffMcpConfig {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.command === "string" || typeof record.url === "string";
}

/** Load mcpServers from session cwd (and parent/home), later paths override. */
export function loadMcpJsonForCwd(cwd: string): Record<string, CodebuffMcpConfig> {
  const dirs = [
    path.join(cwd, ".agents"),
    path.join(cwd, "..", ".agents"),
    path.join(homedir(), ".agents"),
  ];
  const merged: Record<string, CodebuffMcpConfig> = {};
  for (const dir of dirs) {
    const file = path.join(dir, "mcp.json");
    try {
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, "utf8")) as RawMcpFile;
      const servers = parsed.mcpServers;
      if (!servers || typeof servers !== "object") continue;
      for (const [name, config] of Object.entries(servers)) {
        if (isCodebuffMcpConfig(config)) merged[name] = config;
      }
    } catch {
      // Invalid mcp.json is non-fatal.
    }
  }
  return merged;
}

/**
 * Merge host ACP mcpServers with `.agents/mcp.json` under `cwd`.
 * Host servers take precedence on name collision.
 */
export function resolveRunMcpServers(
  acpServers?: AcpMcpServer[],
  cwd: string = process.cwd(),
): Record<string, CodebuffMcpConfig> {
  const merged: Record<string, CodebuffMcpConfig> = loadMcpJsonForCwd(cwd);
  if (acpServers) {
    for (const server of acpServers) {
      if (!server?.name) continue;
      const config = acpServerToCodebuffConfig(server);
      if (config) merged[server.name] = config;
    }
  }
  return merged;
}
