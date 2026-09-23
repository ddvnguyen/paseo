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

- `newSession` creates an in-memory conversation backed by an SDK `RunState`
  and writes a resume snapshot under `FREEBUFF_ACP_STATE_DIR`
  (default `~/.local/state/freebuff-acp/sessions`).
- `session/prompt` runs a turn and streams `agent_message_chunk`,
  `agent_thought_chunk`, `tool_call`, and `tool_call_update` updates.
- `session/cancel` aborts the in-flight turn via `AbortSignal`.
- Modes: exposes a single `lite` mode (the Freebuff default).
- `session/resume` (ACP unstable resume) rehydrates `RunState` from disk after
  an adapter restart so hosts (Paseo) can continue open sessions without
  blocking. History replay via `session/load` is not advertised; if a host
  still calls it, the adapter restores context without emitting past messages.
- An already-open Freebuff free-session slot is reused (including when it is
  bound to a different catalog model); the run adopts that slot’s model
  instead of waiting on admission.
- `FREEBUFF_MODEL` requests a catalog model at admission time (default GLM
  5.3 Flash). It only takes effect when admission actually POSTs a new slot —
  an already-open reused slot's model always wins, since the run must match
  the slot it holds.

## Scope and limits

- Images/audio and embedded context blocks in prompts are not advertised.
- Host MCP servers (`session/new`) and `.agents/mcp.json` (session cwd →
  parent → home) are merged into every root agent definition; the `skill`
  tool is enabled and loads skills from `~/.agents/skills` and
  `{cwd}/.agents/skills` via the SDK.
- Freebuff model selection happens on the backend (the free tier's catalog).
  `FREEBUFF_MODEL` requests a model at admission time, but the adapter does
  not switch models mid-session — a reused open slot keeps its own model.
