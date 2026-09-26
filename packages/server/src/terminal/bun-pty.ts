import { constants } from "node:os";

// node-pty persistent shells die under Bun 1.4: the kernel HUPs the pty
// master ~5ms after spawn though nobody closes it (Bun 1.4's native layer
// hangs it up out-of-band; invisible to strace). Bun 1.4 ships a native PTY
// (Bun.Terminal + Bun.spawn { terminal }) that holds shells correctly, so
// use it when present. node-pty stays the backend everywhere else
// (including upstream Node).

export interface BunPtySpawnOptions {
  command: string;
  args: string[];
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export interface BunPtyExit {
  exitCode: number;
  signal?: number;
}

// Minimal structural mirror of the node-pty surface terminal.ts uses, so
// createTerminal can hold either backend behind one local type.
export interface PtyProcessLike {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exit: BunPtyExit) => void): void;
}

export interface BunTerminalLike {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface BunSubprocessLike {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly terminal: BunTerminalLike | null;
  kill(signal?: string): void;
}

export interface BunSpawnOptions {
  terminal: {
    cols: number;
    rows: number;
    name?: string;
    data?: (terminal: unknown, data: Uint8Array) => void;
  };
  cwd: string;
  env: Record<string, string>;
  stdin: null;
  stdout: null;
  stderr: null;
}

export interface BunRuntimeLike {
  spawn(command: string[], options: BunSpawnOptions): BunSubprocessLike;
}

export function getBunRuntime(): BunRuntimeLike | null {
  const globals: unknown = globalThis;
  if (typeof globals !== "object" || globals === null || !("Bun" in globals)) {
    return null;
  }
  const candidate: unknown = globals.Bun;
  if (typeof candidate !== "object" || candidate === null || !("spawn" in candidate)) {
    return null;
  }
  if (typeof candidate.spawn !== "function") {
    return null;
  }
  // Spawn-function presence checked above; structural boundary cast below.
  const runtime: BunRuntimeLike = candidate as BunRuntimeLike;
  return runtime;
}

export function spawnBunPtyProcess(
  options: BunPtySpawnOptions,
  runtime: BunRuntimeLike,
): PtyProcessLike {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(exit: BunPtyExit) => void>();
  const decoder = new TextDecoder();
  let exited = false;
  let terminal: BunTerminalLike | null = null;

  const forwardData = (chunk: Uint8Array): void => {
    if (exited) {
      return;
    }
    const text = decoder.decode(chunk, { stream: true });
    if (text.length === 0) {
      return;
    }
    for (const listener of Array.from(dataListeners)) {
      listener(text);
    }
  };

  const emitExit = (exitCode: number | null, signalName: string | null): void => {
    if (exited) {
      return;
    }
    exited = true;
    const tail = decoder.decode();
    if (tail.length > 0) {
      for (const listener of Array.from(dataListeners)) {
        listener(tail);
      }
    }
    // Spread into a plain record so arbitrary runtime names are indexable.
    const signalsByName: Record<string, number | undefined> = { ...constants.signals };
    const signal = signalName ? signalsByName[signalName] : undefined;
    // node-pty reports exitCode 0 alongside a signal; match that shape.
    const exit: BunPtyExit =
      signal === undefined ? { exitCode: exitCode ?? 0 } : { exitCode: exitCode ?? 0, signal };
    for (const listener of Array.from(exitListeners)) {
      listener(exit);
    }
    try {
      terminal?.close();
    } catch {
      // already closed by the runtime
    }
  };

  const proc = runtime.spawn([options.command, ...options.args], {
    terminal: {
      cols: options.cols,
      rows: options.rows,
      name: "xterm-256color",
      data: (_terminal, chunk) => forwardData(chunk),
    },
    cwd: options.cwd,
    env: options.env,
    stdin: null,
    stdout: null,
    stderr: null,
  });
  terminal = proc.terminal;

  void proc.exited.then(
    () => emitExit(proc.exitCode, proc.signalCode),
    () => emitExit(null, null),
  );

  return {
    get pid() {
      return proc.pid;
    },
    write(data: string): void {
      if (!exited) {
        terminal?.write(data);
      }
    },
    resize(cols: number, rows: number): void {
      if (!exited) {
        terminal?.resize(cols, rows);
      }
    },
    kill(signal?: string): void {
      // node-pty's default kill is SIGHUP; match it so graceful shutdown
      // behaves the same on both backends.
      proc.kill(signal ?? "SIGHUP");
    },
    onData(listener: (data: string) => void): void {
      dataListeners.add(listener);
    },
    onExit(listener: (exit: BunPtyExit) => void): void {
      exitListeners.add(listener);
    },
  };
}
