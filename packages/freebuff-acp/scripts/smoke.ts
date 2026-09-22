import { FreebuffAcpAgent } from "../src/agent.js";
import { resolveCredentials } from "../src/auth.js";

const credentials = resolveCredentials();
if (!credentials) {
  console.error("SKIP: no credentials (run `freebuff login` first)");
  process.exit(2);
}
console.log("auth source:", credentials.source);

const updates: Array<Record<string, unknown>> = [];
const agent = new FreebuffAcpAgent(
  {
    sessionUpdate: async (params) => {
      updates.push(params as unknown as Record<string, unknown>);
    },
  },
  process.env,
);

await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as never);

const session = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as never);
console.log("session:", session.sessionId, "mode:", session.modes?.currentModeId);

const response = await agent.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: "Reply with exactly: FREEBUFF_ACP_OK" }],
} as never);
console.log("stopReason:", response.stopReason);
for (const update of updates) {
  const kind = (update as { update?: { sessionUpdate?: string } }).update?.sessionUpdate;
  if (kind === "agent_message_chunk") {
    const content = (update as { update?: { content?: { text?: string } } }).update?.content;
    console.log("text:", content?.text?.slice(0, 120));
  } else if (kind === "tool_call") {
    console.log("tool_call:", (update as { update?: { title?: string } }).update?.title);
  }
}
process.exit(response.stopReason === "end_turn" ? 0 : 1);
