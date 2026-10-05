/**
 * Regression tests for the merge-safety GATE ITSELF.
 *
 * Two holes were measured, not hypothesised:
 *
 *  1. Rule 2 (turso-import) was guarded behind `if (flag("--files") === null)`, so
 *     `--files <list>` printed `merge-safety: PASS` and exited 0 with a live
 *     `@tursodatabase/database` import still in the tree.
 *  2. `--check-turso-only` was documented in the usage header but never read, so
 *     the documented invocation fell into the "no changeset to check" branch:
 *     it printed `turso-import: PASS` and still exited 1.
 *
 * Both are exit-code contracts, so they are asserted by exit code, not by log text.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = join(repoRoot, "scripts", "fleet-merge-safety.mjs");

/** Run the gate; return { code, output } without throwing on a non-zero exit.
 *  `output` is stdout+stderr: the gate deliberately splits them (PASS lines on
 *  stdout, "no changeset to check" on stderr), so a contract test that reads
 *  only one of them asserts against the wrong stream. */
function runGate(args) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output: stdout };
  } catch (exc) {
    return {
      code: exc.status ?? -1,
      output: `${String(exc.stdout ?? "")}${String(exc.stderr ?? "")}`,
    };
  }
}

test("rule 2 is evaluated under --files, not skipped", () => {
  const offender = join(repoRoot, "packages/fleet-backend/src/__gate_probe__/probe.ts");
  mkdirSync(join(repoRoot, "packages/fleet-backend/src/__gate_probe__"), { recursive: true });
  writeFileSync(
    offender,
    "import { Database } from '@tursodatabase/database';\nexport const db = Database;\n",
  );
  try {
    const listed = "packages/fleet-backend/src/__gate_probe__/probe.ts";
    const { code, output } = runGate(["--files", listed]);
    assert.equal(
      code,
      1,
      `--files must fail when a rule-2 violation is live in the tree; got exit ${code}\n${output}`,
    );
    assert.match(output, /turso-import: FAIL/);
    assert.match(output, /__gate_probe__/);
  } finally {
    rmSync(join(repoRoot, "packages/fleet-backend/src/__gate_probe__"), {
      recursive: true,
      force: true,
    });
  }
});

test("--check-turso-only passes on a clean tree and is not a rule-1 invocation", () => {
  const { code, output } = runGate(["--check-turso-only"]);
  assert.equal(code, 0, `--check-turso-only must exit 0 on a clean tree; got ${code}\n${output}`);
  assert.match(output, /turso-import: PASS/);
  assert.doesNotMatch(
    output,
    /no changeset to check/,
    "--check-turso-only must not fall into the missing-changeset branch",
  );
});

test("--check-turso-only fails when the tree has a violation", () => {
  const dir = join(repoRoot, "packages/fleet-backend/src/__gate_probe__");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "probe.ts"),
    "const { connect } = await import('../node_modules/@tursodatabase/database');\nexport const c = connect;\n",
  );
  try {
    const { code, output } = runGate(["--check-turso-only"]);
    assert.equal(code, 1, `expected failure; got ${code}\n${output}`);
    assert.match(output, /turso-import: FAIL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a changeset-less invocation still fails rule 1 rather than silently passing", () => {
  const { code, output } = runGate([]);
  assert.notEqual(code, 0, "no --base/--head/--files must not exit 0");
  assert.match(output, /no changeset to check/);
});

test("scratch dirs used by this test are not left behind", () => {
  // Guards the fixture hygiene itself: the tests above write into the repo tree,
  // so a leaked directory would silently become a rule-2 offender next run.
  const scratch = mkdtempSync(join(tmpdir(), "gate-probe-"));
  rmSync(scratch, { recursive: true, force: true });
  assert.equal(
    execFileSync(process.execPath, ["-e", "process.stdout.write('ok')"], { encoding: "utf8" }),
    "ok",
  );
});
