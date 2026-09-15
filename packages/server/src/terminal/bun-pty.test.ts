import { describe, expect, it } from "vitest";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import {
  getBunRuntime,
  spawnBunPtyProcess,
  type BunPtySpawnOptions,
  type BunRuntimeLike,
  type BunSpawnOptions,
  type BunSubprocessLike,
  type BunTerminalLike,
} from "./bun-pty.js";

interface FakeTerminal extends BunTerminalLike {
  written: string[];
  resizes: Array<[number, number]>;
  closed: number;
  emitData: (chunk: Uint8Array) => void;
}

interface FakeProc extends BunSubprocessLike {
  killSignals: Array<string | undefined>;
  terminal: FakeTerminal;
  finish(code: number | null, signal: string | null): void;
  fail(reason?: unknown): void;
}

interface FakeSpawn {
  runtime: BunRuntimeLike;
  commands: string[][];
  options: BunSpawnOptions[];
  procs: FakeProc[];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createFakeSpawn(): FakeSpawn {
  const commands: string[][] = [];
  const options: BunSpawnOptions[] = [];
  const procs: FakeProc[] = [];
  const runtime: BunRuntimeLike = {
    spawn(command: string[], spawnOptions: BunSpawnOptions): BunSubprocessLike {
      commands.push(command);
      options.push(spawnOptions);
      const gate = deferred<number>();
      const terminal: FakeTerminal = {
        written: [],
        resizes: [],
        closed: 0,
        emitData: (chunk: Uint8Array) => spawnOptions.terminal.data?.({}, chunk),
        write: (data: string | Uint8Array) => {
          terminal.written.push(typeof data === "string" ? data : Buffer.from(data).toString());
        },
        resize: (cols: number, rows: number) => {
          terminal.resizes.push([cols, rows]);
        },
        close: () => {
          terminal.closed += 1;
        },
      };
      const proc: FakeProc = {
        pid: 4242 + procs.length,
        exited: gate.promise,
        exitCode: null,
        signalCode: null,
        terminal,
        killSignals: [],
        kill: (signal?: string) => {
          proc.killSignals.push(signal);
        },
        finish: (code: number | null, signal: string | null) => {
          proc.exitCode = code;
          proc.signalCode = signal;
          gate.resolve(code ?? 128);
        },
        fail: (reason?: unknown) => {
          gate.reject(reason ?? new Error("exited failed"));
        },
      };
      procs.push(proc);
      return proc;
    },
  };
  return { runtime, commands, options, procs };
}

const spawnOptions: BunPtySpawnOptions = {
  command: "/bin/bash",
  args: ["--noprofile", "--norc"],
  cols: 80,
  rows: 30,
  cwd: "/tmp",
  env: { TERM: "xterm-256color" },
};

describe("spawnBunPtyProcess", () => {
  it("spawns through the Bun runtime with a dedicated terminal", () => {
    const fake = createFakeSpawn();
    const ptyProcess = spawnBunPtyProcess(spawnOptions, fake.runtime);

    expect(fake.commands).toEqual([["/bin/bash", "--noprofile", "--norc"]]);
    expect(fake.options[0]?.cwd).toBe("/tmp");
    expect(fake.options[0]?.env).toEqual({ TERM: "xterm-256color" });
    expect(fake.options[0]?.terminal.cols).toBe(80);
    expect(fake.options[0]?.terminal.rows).toBe(30);
    expect(fake.options[0]?.stdin).toBeNull();
    expect(fake.options[0]?.stdout).toBeNull();
    expect(fake.options[0]?.stderr).toBeNull();
    expect(ptyProcess.pid).toBe(4242);
  });

  it("decodes streamed output split across multibyte boundaries", () => {
    const fake = createFakeSpawn();
    const ptyProcess = spawnBunPtyProcess(spawnOptions, fake.runtime);
    const received: string[] = [];
    ptyProcess.onData((data) => received.push(data));

    const bytes = Buffer.from("héllo", "utf8");
    fake.procs[0]?.terminal.emitData(bytes.subarray(0, 2));
    fake.procs[0]?.terminal.emitData(bytes.subarray(2));

    expect(received.join("")).toBe("héllo");
  });

  it("maps exit codes and signal names to the node-pty shape", async () => {
    const fake = createFakeSpawn();
    const clean = spawnBunPtyProcess(spawnOptions, fake.runtime);
    const signaled = spawnBunPtyProcess(spawnOptions, fake.runtime);
    const unknownSignal = spawnBunPtyProcess(spawnOptions, fake.runtime);
    const cleanExits: unknown[] = [];
    const signaledExits: unknown[] = [];
    const unknownExits: unknown[] = [];
    clean.onExit((exit) => cleanExits.push(exit));
    signaled.onExit((exit) => signaledExits.push(exit));
    unknownSignal.onExit((exit) => unknownExits.push(exit));

    fake.procs[0]?.finish(0, null);
    fake.procs[1]?.finish(null, "SIGTERM");
    fake.procs[2]?.finish(null, "SIGFOO");
    await waitForImmediate();

    expect(cleanExits).toEqual([{ exitCode: 0 }]);
    expect(signaledExits).toEqual([{ exitCode: 0, signal: 15 }]);
    expect(unknownExits).toEqual([{ exitCode: 0 }]);
  });

  it("flushes a truncated decoder tail before exit listeners run", async () => {
    const fake = createFakeSpawn();
    const ptyProcess = spawnBunPtyProcess(spawnOptions, fake.runtime);
    const events: string[] = [];
    ptyProcess.onData((data) => events.push(`data:${data}`));
    ptyProcess.onExit((exit) => events.push(`exit:${exit.exitCode}`));

    const leadByte = Buffer.from("é", "utf8").subarray(0, 1);
    fake.procs[0]?.terminal.emitData(Buffer.concat([Buffer.from("a"), leadByte]));
    fake.procs[0]?.finish(0, null);
    await waitForImmediate();

    // The cut-off byte cannot complete, so the flush emits U+FFFD — but it
    // still reaches data listeners before any exit listener runs.
    expect(events).toEqual(["data:a", "data:�", "exit:0"]);
  });

  it("delegates write/resize/kill and defaults kills to SIGHUP", async () => {
    const fake = createFakeSpawn();
    const ptyProcess = spawnBunPtyProcess(spawnOptions, fake.runtime);
    const proc = fake.procs[0];
    if (!proc) {
      throw new Error("expected a spawned process");
    }

    ptyProcess.write("echo hi\r");
    ptyProcess.resize(120, 40);
    ptyProcess.kill();
    expect(proc.terminal.written).toEqual(["echo hi\r"]);
    expect(proc.terminal.resizes).toEqual([[120, 40]]);
    expect(proc.killSignals).toEqual(["SIGHUP"]);

    ptyProcess.kill("SIGKILL");
    proc.finish(null, "SIGKILL");
    await waitForImmediate();

    expect(proc.killSignals).toEqual(["SIGHUP", "SIGKILL"]);
    expect(proc.terminal.closed).toBe(1);
    ptyProcess.write("dropped\r");
    ptyProcess.resize(80, 30);
    expect(proc.terminal.written).toEqual(["echo hi\r"]);
    expect(proc.terminal.resizes).toEqual([[120, 40]]);
  });

  it("reports an unknown exit when the exited promise rejects", async () => {
    const fake = createFakeSpawn();
    const ptyProcess = spawnBunPtyProcess(spawnOptions, fake.runtime);
    const exits: unknown[] = [];
    ptyProcess.onExit((exit) => exits.push(exit));

    fake.procs[0]?.fail();
    await waitForImmediate();

    expect(exits).toEqual([{ exitCode: 0 }]);
  });
});

describe("getBunRuntime", () => {
  it("returns null when no Bun global is present", () => {
    expect(getBunRuntime()).toBeNull();
  });

  it("detects a Bun-shaped global", () => {
    const holder = globalThis as unknown as Record<string, unknown>;
    const prior = holder.Bun;
    holder.Bun = {
      spawn: () => {
        throw new Error("unused");
      },
    };
    try {
      expect(getBunRuntime()).not.toBeNull();
    } finally {
      if (prior === undefined) {
        delete holder.Bun;
      } else {
        holder.Bun = prior;
      }
    }
  });
});
