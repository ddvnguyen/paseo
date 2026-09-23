import { Readable, Writable } from "node:stream";

import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

import { FreebuffAcpAgent } from "./agent.js";

// Patch point for the published @codebuff/sdk (0.10.7): it builds each LLM
// request's codebuff_metadata from fixed keys and has no official way to add
// `freebuff_instance_id`. The SDK dist in this workspace carries a one-line
// spread of `globalThis.__freebuffExtraCodebuffMetadata` into that object (a
// stand-in for the upstream `extraCodebuffMetadata` option). Set the shape
// here so the key always exists; turn.ts fills it per run.
(
  globalThis as typeof globalThis & { __freebuffExtraCodebuffMetadata?: Record<string, string> }
).__freebuffExtraCodebuffMetadata ??= {};

// ACP's ndJsonStream expects web streams; bridge Node's stdio streams to them.
const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = ndJsonStream(output, input);
const connection = new AgentSideConnection((conn) => new FreebuffAcpAgent(conn), stream);

// Exit when the host closes the stdio connection so the process never lingers.
connection.closed.then(
  () => process.exit(0),
  () => process.exit(1),
);
