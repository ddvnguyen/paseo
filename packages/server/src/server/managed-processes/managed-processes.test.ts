import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  createManagedProcessRegistry,
  createPidTarget,
  createSystemManagedProcessTable,
  type ManagedProcessCommandRunner,
  type ManagedProcessInspection,
  type ManagedProcessSnapshot,
  type ManagedProcessTable,
} from "./managed-processes.js";
import { spawnProcess } from "../../utils/spawn.js";
import {
  terminateWithTreeKill,
  type ProcessTerminator,
  type TreeKillTarget,
} from "../../utils/tree-kill.js";

let tempHome: string | null = null;

afterEach(async () => {
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
});

describe("managed process registry", () => {
  test("reaps a validated leftover helper process and deletes its record", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      {
        pid: 4101,
        commandLine: "opencode serve --port 4101",
        startedAt: "process-start-token",
      },
    ]);
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4101,
      command: "opencode",
      args: ["serve", "--port", "4101"],
      metadata: { port: 4101 },
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toEqual({
      checked: 1,
      dead: 0,
      mismatched: 0,
      skipped: 0,
      removed: 1,
      terminated: 1,
      errors: [],
    });
    expect(terminator.terminatedPids).toEqual([4101]);
    expect(await restartedRegistry.list()).toEqual([]);
  });

  test("deletes a dead helper process record without terminating a PID", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      {
        pid: 4102,
        commandLine: "opencode serve --port 4102",
        startedAt: "process-start-token",
      },
    ]);
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4102,
      command: "opencode",
      args: ["serve", "--port", "4102"],
      metadata: { port: 4102 },
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toEqual({
      checked: 1,
      dead: 1,
      mismatched: 0,
      skipped: 0,
      removed: 1,
      terminated: 0,
      errors: [],
    });
    expect(terminator.terminatedPids).toEqual([]);
    expect(await restartedRegistry.list()).toEqual([]);
  });

  test("removes a reused PID record without terminating the new process", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4103,
          commandLine: "opencode serve --port 4103",
          startedAt: "original-start-token",
        },
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4103,
      command: "opencode",
      args: ["serve", "--port", "4103"],
      metadata: { port: 4103 },
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4103,
          commandLine: "opencode serve --port 4103",
          startedAt: "new-process-start-token",
        },
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toEqual({
      checked: 1,
      dead: 0,
      mismatched: 1,
      skipped: 0,
      removed: 1,
      terminated: 0,
      errors: [],
    });
    expect(terminator.terminatedPids).toEqual([]);
    expect(await restartedRegistry.list()).toEqual([]);
  });

  test("keeps a helper record when inspection fails instead of orphaning a live process", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        { pid: 4104, commandLine: "opencode serve --port 4104", startedAt: "process-start-token" },
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4104,
      command: "opencode",
      args: ["serve", "--port", "4104"],
      metadata: { port: 4104 },
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([], [4104]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toMatchObject({
      checked: 1,
      dead: 0,
      mismatched: 0,
      skipped: 0,
      removed: 0,
      terminated: 0,
    });
    expect(result.errors).toEqual([{ id: expect.any(String), message: "inspection failed" }]);
    expect(terminator.terminatedPids).toEqual([]);
    expect(await restartedRegistry.list()).toHaveLength(1);
  });

  test("does not terminate a reused PID whose command line only mentions the tokens", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([], [4105]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4105,
      command: "opencode",
      args: ["serve", "--port", "4105"],
      metadata: { port: 4105 },
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4105,
          commandLine: "node /tmp/serve.js --port 4105 # opencode helper",
          startedAt: null,
        },
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toEqual({
      checked: 1,
      dead: 0,
      mismatched: 1,
      skipped: 0,
      removed: 1,
      terminated: 0,
      errors: [],
    });
    expect(terminator.terminatedPids).toEqual([]);
    expect(await restartedRegistry.list()).toEqual([]);
  });
});

describe("boot reaper gate for agent hosts", () => {
  // A stamp far enough in the past that no process running under this boot could
  // carry it, and a stamp from now, which is the only shape a survivor can have.
  const beforeThisBoot = new Date(Date.now() - 86_400_000).toISOString();
  const duringThisBoot = new Date().toISOString();

  function agentHostSnapshot(pid: number, startedAt: string | null) {
    return { pid, commandLine: "paseo-agent-host --port 7000", startedAt };
  }

  // Records through the registry so identity comes from the process table, exactly
  // as a real launch would stamp it.
  async function reapWithIdentity(args: {
    ownerKind: string;
    pid: number;
    recordStartedAt: string | null;
    liveStartedAt: string | null;
  }) {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([agentHostSnapshot(args.pid, args.recordStartedAt)]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "paseo", kind: args.ownerKind },
      pid: args.pid,
      command: "paseo-agent-host",
      args: ["--port", "7000"],
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([agentHostSnapshot(args.pid, args.liveStartedAt)]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();
    return { result, terminator, registry: restartedRegistry };
  }

  test("reaps an agent-host record stamped before this boot", async () => {
    const { result, terminator, registry } = await reapWithIdentity({
      ownerKind: "agent-host",
      pid: 4201,
      recordStartedAt: beforeThisBoot,
      liveStartedAt: beforeThisBoot,
    });

    expect(result).toEqual({
      checked: 1,
      dead: 0,
      mismatched: 0,
      skipped: 0,
      removed: 1,
      terminated: 1,
      errors: [],
    });
    expect(terminator.terminatedPids).toEqual([4201]);
    expect(await registry.list()).toEqual([]);
  });

  test("leaves an agent host from this boot running for re-attach", async () => {
    const { result, terminator, registry } = await reapWithIdentity({
      ownerKind: "agent-host",
      pid: 4202,
      recordStartedAt: duringThisBoot,
      liveStartedAt: duringThisBoot,
    });

    expect(result).toEqual({
      checked: 1,
      dead: 0,
      mismatched: 0,
      skipped: 1,
      removed: 0,
      terminated: 0,
      errors: [],
    });
    expect(terminator.terminatedPids).toEqual([]);
    // The record survives too: it is the handle the next daemon re-attaches through.
    expect(await registry.list()).toHaveLength(1);
  });

  test("reaps an agent host whose identity no longer matches", async () => {
    // Same owner kind and same boot, but the PID now names a different process.
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([agentHostSnapshot(4203, duringThisBoot)]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "paseo", kind: "agent-host" },
      pid: 4203,
      command: "paseo-agent-host",
      args: ["--port", "7000"],
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        agentHostSnapshot(4203, new Date(Date.now() + 60_000).toISOString()),
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toEqual({
      checked: 1,
      dead: 0,
      mismatched: 1,
      skipped: 0,
      removed: 1,
      terminated: 0,
      errors: [],
    });
    expect(terminator.terminatedPids).toEqual([]);
    expect(await restartedRegistry.list()).toEqual([]);
  });

  test("reaps an agent host with no start stamp, having proved neither half", async () => {
    const { result, terminator, registry } = await reapWithIdentity({
      ownerKind: "agent-host",
      pid: 4204,
      recordStartedAt: null,
      liveStartedAt: duringThisBoot,
    });

    expect(result.skipped).toBe(0);
    expect(terminator.terminatedPids).toEqual([4204]);
    expect(await registry.list()).toEqual([]);
  });

  test("does not spare other owner kinds stamped during this boot", async () => {
    const { result, terminator, registry } = await reapWithIdentity({
      ownerKind: "helper-server",
      pid: 4205,
      recordStartedAt: duringThisBoot,
      liveStartedAt: duringThisBoot,
    });

    expect(result).toEqual({
      checked: 1,
      dead: 0,
      mismatched: 0,
      skipped: 0,
      removed: 1,
      terminated: 1,
      errors: [],
    });
    expect(terminator.terminatedPids).toEqual([4205]);
    expect(await registry.list()).toEqual([]);
  });
});

describe("managed process termination", () => {
  test("stops as soon as a terminated process exits instead of escalating to SIGKILL", async () => {
    const child = spawnProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const pid = child.pid;
    if (!pid) {
      throw new Error("Failed to spawn test process");
    }

    let forced = false;
    const result = await terminateWithTreeKill(createPidTarget(pid), {
      gracefulTimeoutMs: 2_000,
      forceTimeoutMs: 1_000,
      onForceSignal: () => {
        forced = true;
      },
    });

    expect(result).toBe("terminated");
    expect(forced).toBe(false);
  });
});

describe("system managed process table", () => {
  test("reads POSIX process identity from ps", async () => {
    const commandRunner = new FakeCommandRunner([
      {
        stdout: "Sat Jun 20 10:30:40 2026 opencode serve --port 4101\n",
        stderr: "",
      },
    ]);
    const processTable = createSystemManagedProcessTable({
      platform: "darwin",
      commandRunner,
    });

    const inspection = await processTable.inspect(4101);

    expect(inspection).toEqual({
      status: "alive",
      snapshot: {
        pid: 4101,
        commandLine: "opencode serve --port 4101",
        startedAt: "Sat Jun 20 10:30:40 2026",
      },
    });
    expect(commandRunner.commands).toEqual([
      {
        command: "ps",
        args: ["-ww", "-p", "4101", "-o", "lstart=", "-o", "command="],
      },
    ]);
  });

  test("reads Windows process identity from PowerShell", async () => {
    const commandRunner = new FakeCommandRunner([
      {
        stdout: JSON.stringify({
          ProcessId: 4101,
          CommandLine: "C:\\opencode.exe serve --port 4101",
          CreationDate: "20260620103040.000000+000",
        }),
        stderr: "",
      },
    ]);
    const processTable = createSystemManagedProcessTable({
      platform: "win32",
      commandRunner,
    });

    const inspection = await processTable.inspect(4101);

    expect(inspection).toEqual({
      status: "alive",
      snapshot: {
        pid: 4101,
        commandLine: "C:\\opencode.exe serve --port 4101",
        startedAt: "20260620103040.000000+000",
      },
    });
    expect(commandRunner.commands).toEqual([
      {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$process = Get-CimInstance Win32_Process -Filter 'ProcessId = 4101'; if ($process) { $process | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress }",
        ],
      },
    ]);
  });
});

class FakeProcessTable implements ManagedProcessTable {
  private readonly snapshots: Map<number, ManagedProcessSnapshot>;
  private readonly errorPids: Set<number>;

  constructor(snapshots: ManagedProcessSnapshot[], errorPids: number[] = []) {
    this.snapshots = new Map(snapshots.map((snapshot) => [snapshot.pid, snapshot]));
    this.errorPids = new Set(errorPids);
  }

  async inspect(pid: number): Promise<ManagedProcessInspection> {
    if (this.errorPids.has(pid)) {
      return { status: "error", error: new Error("inspection failed") };
    }
    const snapshot = this.snapshots.get(pid);
    return snapshot ? { status: "alive", snapshot } : { status: "not-found" };
  }
}

class FakeProcessTerminator {
  readonly terminatedPids: number[] = [];

  readonly terminate: ProcessTerminator = async (target: TreeKillTarget) => {
    this.terminatedPids.push(target.pid ?? -1);
    return "terminated";
  };
}

class FakeCommandRunner implements ManagedProcessCommandRunner {
  readonly commands: Array<{ command: string; args: string[] }> = [];
  private readonly responses: Array<{ stdout: string; stderr: string }>;

  constructor(responses: Array<{ stdout: string; stderr: string }>) {
    this.responses = [...responses];
  }

  async exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.commands.push({ command, args });
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No fake process-table command response available");
    }
    return response;
  }
}
