import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPlatform } from "../test-utils/platform.js";
import { getWorktreeSetupCommands, getWorktreeTeardownCommands } from "./worktree.js";
import {
  readPaseoConfigForEdit,
  statPaseoConfigPath,
  writePaseoConfigForEdit,
} from "./paseo-config-file.js";

describe("paseo config file substrate", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "paseo-config-file-test-")));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null config and revision when paseo.json is missing", () => {
    const result = readPaseoConfigForEdit(tempDir);

    expect(result).toEqual({ ok: true, config: null, revision: null });
  });

  it("returns invalid_project_config for invalid JSON", () => {
    writeFileSync(join(tempDir, "paseo.json"), "{ invalid json\n");

    const result = readPaseoConfigForEdit(tempDir);

    expect(result).toEqual({
      ok: false,
      error: { code: "invalid_project_config" },
    });
  });

  it("preserves raw lifecycle string and array forms with a revision token", () => {
    writeFileSync(
      join(tempDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          setup: "npm install",
          teardown: ["npm run clean", "npm run reset"],
        },
      }),
    );

    const result = readPaseoConfigForEdit(tempDir);

    expect(result).toEqual({
      ok: true,
      config: {
        worktree: {
          setup: "npm install",
          teardown: ["npm run clean", "npm run reset"],
        },
      },
      revision: statPaseoConfigPath(tempDir),
    });
  });

  it("keeps runtime lifecycle commands normalized for execution", () => {
    writeFileSync(
      join(tempDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          setup: "npm install",
          teardown: ["npm run clean", "", 42, "npm run reset"],
        },
      }),
    );

    expect(getWorktreeSetupCommands(tempDir)).toEqual(["npm install"]);
    expect(getWorktreeTeardownCommands(tempDir)).toEqual(["npm run clean", "npm run reset"]);
  });

  it("writes pretty JSON with a trailing newline when revision matches", () => {
    writeFileSync(join(tempDir, "paseo.json"), JSON.stringify({ worktree: { setup: "old" } }));
    const expectedRevision = statPaseoConfigPath(tempDir);

    const result = writePaseoConfigForEdit({
      repoRoot: tempDir,
      config: { worktree: { setup: "npm install" } },
      expectedRevision,
    });

    expect(result).toEqual({
      ok: true,
      config: { worktree: { setup: "npm install" } },
      revision: statPaseoConfigPath(tempDir),
    });
    expect(readFileSync(join(tempDir, "paseo.json"), "utf8")).toBe(
      '{\n  "worktree": {\n    "setup": "npm install"\n  }\n}\n',
    );
  });

  // POSIX-only: Windows mtime granularity can collapse the two revisions in this fixture.
  it.skipIf(isPlatform("win32"))(
    "rejects stale writes when the current revision changed before rename",
    () => {
      writeFileSync(join(tempDir, "paseo.json"), JSON.stringify({ worktree: { setup: "old" } }));
      const expectedRevision = statPaseoConfigPath(tempDir);
      writeFileSync(join(tempDir, "paseo.json"), JSON.stringify({ worktree: { setup: "new" } }));
      const currentRevision = statPaseoConfigPath(tempDir);

      const result = writePaseoConfigForEdit({
        repoRoot: tempDir,
        config: { worktree: { setup: "from editor" } },
        expectedRevision,
      });

      expect(result).toEqual({
        ok: false,
        error: { code: "stale_project_config", currentRevision },
      });
      expect(readFileSync(join(tempDir, "paseo.json"), "utf8")).toBe(
        JSON.stringify({ worktree: { setup: "new" } }),
      );
    },
  );

  it("round-trips unknown top-level, worktree, and script-entry fields", () => {
    const config = {
      extraTop: { keep: true },
      worktree: {
        setup: ["npm install"],
        customWorktreeField: "preserve me",
      },
      scripts: {
        dev: {
          command: "npm run dev",
          type: "service",
          customScriptField: 123,
        },
      },
    };

    const result = writePaseoConfigForEdit({
      repoRoot: tempDir,
      config,
      expectedRevision: null,
    });

    expect(result).toEqual({
      ok: true,
      config,
      revision: statPaseoConfigPath(tempDir),
    });
    expect(readPaseoConfigForEdit(tempDir)).toEqual({
      ok: true,
      config,
      revision: statPaseoConfigPath(tempDir),
    });
  });

  // paseo.json carries provider `env`, so a save can persist API keys into a file
  // inside the user's checkout. Anything but owner-only mode leaks them to every
  // other local account. POSIX-only: Windows has no POSIX mode bits.
  it.skipIf(isPlatform("win32"))("writes paseo.json owner-only, secrets included", () => {
    const result = writePaseoConfigForEdit({
      repoRoot: tempDir,
      config: {
        providers: { claude: { env: { ANTHROPIC_API_KEY: "sk-ant-test-value" } } },
      },
      expectedRevision: null,
    });

    expect(result.ok).toBe(true);
    expect(statSync(join(tempDir, "paseo.json")).mode & 0o777).toBe(0o600);
  });

  // The checkout belongs to the user, not to Paseo. Locking the directory down to
  // 0700 would be a side effect on someone else's tree (and breaks group-shared
  // checkouts), so only the file mode may change.
  it.skipIf(isPlatform("win32"))(
    "leaves the containing checkout directory permissions alone",
    () => {
      const repoRoot = join(tempDir, "checkout");
      mkdirSync(repoRoot, { mode: 0o755 });
      const before = statSync(repoRoot).mode & 0o777;

      const result = writePaseoConfigForEdit({
        repoRoot,
        config: { worktree: { setup: "npm install" } },
        expectedRevision: null,
      });

      expect(result.ok).toBe(true);
      expect(statSync(repoRoot).mode & 0o777).toBe(before);
      expect(statSync(join(repoRoot, "paseo.json")).mode & 0o777).toBe(0o600);
    },
  );

  it("returns write_failed for filesystem write exceptions", () => {
    const fileRoot = join(tempDir, "not-a-directory");
    writeFileSync(fileRoot, "file");

    const result = writePaseoConfigForEdit({
      repoRoot: fileRoot,
      config: { worktree: { setup: "npm install" } },
      expectedRevision: null,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "write_failed" },
    });
  });

  it("creates paseo.json when the file is still missing and expected revision is null", () => {
    mkdirSync(join(tempDir, "nested"));

    const result = writePaseoConfigForEdit({
      repoRoot: join(tempDir, "nested"),
      config: { scripts: { dev: { command: "npm run dev" } } },
      expectedRevision: null,
    });

    expect(result).toEqual({
      ok: true,
      config: { scripts: { dev: { command: "npm run dev" } } },
      revision: statPaseoConfigPath(join(tempDir, "nested")),
    });
  });
});
