import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { addModelVisibleStructuredContent } from "./tools/paseo-tool-serialization.js";
import { createPaseoToolCatalog, type PaseoToolHostDependencies } from "./tools/paseo-tools.js";
import type { PaseoToolResult } from "./tools/types.js";

// HYDRA PATCH: Pre-parse stringified discriminated union args at the MCP layer.
// LLMs sometimes send complex object args as JSON strings (e.g. target="{...}").
// The MCP SDK validates args with Zod before they reach the tool handler,
// so this preprocessing must happen here to prevent InvalidParams errors.
function preprocessMcpToolArgs(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return input;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 1) {
      const trimmed = value.trim();
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          result[key] = JSON.parse(trimmed);
          continue;
        } catch {
          // Not valid JSON, keep as-is
        }
      }
    }
    result[key] = value;
  }
  return result;
}

function wrapInputSchemaWithPreprocessing(inputSchema: unknown): z.ZodType {
  if (!inputSchema) {
    return z.object({});
  }
  if (
    typeof inputSchema === "object" &&
    inputSchema !== null &&
    typeof (inputSchema as { safeParseAsync?: unknown }).safeParseAsync === "function"
  ) {
    return z.preprocess(preprocessMcpToolArgs, inputSchema as z.ZodType);
  }
  // Raw shape — wrap with preprocess then passthrough
  return z.preprocess(preprocessMcpToolArgs, z.object(inputSchema as z.ZodRawShape).passthrough());
}

export type AgentMcpServerOptions = PaseoToolHostDependencies;

type McpToolContext = RequestHandlerExtra<ServerRequest, ServerNotification>;

function toMcpToolResult(result: PaseoToolResult): CallToolResult {
  const modelVisibleResult = addModelVisibleStructuredContent(result);
  return {
    content: modelVisibleResult.content as CallToolResult["content"],
    ...(modelVisibleResult.structuredContent !== undefined
      ? {
          structuredContent:
            modelVisibleResult.structuredContent as CallToolResult["structuredContent"],
        }
      : {}),
    ...(modelVisibleResult.isError !== undefined ? { isError: modelVisibleResult.isError } : {}),
  };
}

export async function createAgentMcpServer(options: AgentMcpServerOptions): Promise<McpServer> {
  const catalog = await createPaseoToolCatalog(options);
  const server = new McpServer({
    name: "agent-mcp",
    version: "2.0.0",
  });

  for (const tool of catalog.tools.values()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: wrapInputSchemaWithPreprocessing(tool.inputSchema),
      },
      async (args: unknown, context?: McpToolContext) =>
        toMcpToolResult(await catalog.executeTool(tool.name, args, { signal: context?.signal })),
    );
  }

  return server;
}
