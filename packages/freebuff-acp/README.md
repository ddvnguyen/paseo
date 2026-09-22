# freebuff-acp

[Agent Client Protocol (ACP)](https://agentclientprotocol.com) adapter for
[Freebuff](https://freebuff.com) — the free coding agent. It bridges ACP's
JSON-RPC stdio protocol to the Freebuff (Codebuff) backend via
[`@codebuff/sdk`](https://www.npmjs.com/package/@codebuff/sdk), so any ACP host
(Paseo, Zed, …) can drive Freebuff as a first-class agent.

## Why an adapter?

The `freebuff` CLI is an interactive terminal app (TUI) with no machine
interface: no ACP mode, no RPC mode, no JSONL session files. The backend,
however, is fully programmable through `@codebuff/sdk` (streamed events,
multi-turn sessions via `previousRun`). This adapter exposes that
programmatic surface over ACP.

## Usage

```bash
# from this package
pnpm build
node dist/entry.js
```

The process speaks ACP over stdin/stdout (ndjson JSON-RPC). Point your ACP
host at the binary — in Paseo, add the provider from Settings → Providers →
"Freebuff (ACP)".

## Authentication

Credentials resolve in this order:

1. `FREEBUFF_API_KEY` or `CODEBUFF_API_KEY` environment variables
2. The logged-in Freebuff CLI's credential store:
   `~/.config/manicode/credentials.json` (written by `freebuff login`;
   `FREEBUFF_CONFIG_DIR` overrides the directory)

With no credentials, `newSession` fails with a descriptive error and the
adapter advertises an auth method pointing at `freebuff login`.

## Session behavior

- `newSession` creates an in-memory conversation backed by an SDK `RunState`.
- `session/prompt` runs a turn and streams `agent_message_chunk`,
  `agent_thought_chunk`, `tool_call`, and `tool_call_update` updates.
- `session/cancel` aborts the in-flight turn via `AbortSignal`.
- Modes: exposes a single `lite` mode (the Freebuff default).
- `loadSession` is not supported (the SDK's conversation state is
  process-local), and the capability is not advertised.

## Scope and limits

- Images/audio and embedded context blocks in prompts are not advertised.
- MCP servers passed by the host are not forwarded (the SDK manages its own
  tool surface); Paseo injects its host tools through the provider config.
- Freebuff model selection happens on the backend (the free tier's catalog);
  the adapter does not expose model switching.
