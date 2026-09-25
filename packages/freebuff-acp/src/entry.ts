import { Readable, Writable } from "node:stream";

import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

import { FreebuffAcpAgent } from "./agent.js";

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
