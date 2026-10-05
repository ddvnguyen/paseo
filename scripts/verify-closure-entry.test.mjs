// Contract tests for the deploy closure gate.
//
// Background: the pipeline built @getpaseo/cli but its deploy loops copied only
// `client highlight plugin protocol relay server`, so cli/dist never reached the
// env home. The daemon starts THROUGH the cli
// (deploy/systemd/paseo-test.service -> paseo-bun -> exec bun cli/dist/index.js),
// so the daemon crash-looped on `Module not found .../cli/dist/index.js` while
// the gate stayed green — it excluded `cli` on the strength of a comment
// claiming cli was not deployed, and a missing dist has nothing to walk.
//
// These tests pin both halves of the fix so neither can silently regress:
// the static contracts (no bun needed, so they run in the Validate CI contracts
// job) and the behavioural entry-point assertion (needs bun, the daemon runtime).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repoRoot = join(import.meta.dirname, "..");
const pipeline = join(repoRoot, ".github/workflows/paseo-manual-pipeline.yml");
const verifier = join(repoRoot, "deploy/verify-closure.bun.mjs");

// A launcher with the same shape deploy/consolidate-paseo-home.sh generates:
// PKG/DIST are HOME-relative, so a test can point them at its own temp dir.
const LAUNCHER = `#!/usr/bin/env bash
set -euo pipefail
TEST_ROOT="$HOME/paseo/TEST"
PKG="$TEST_ROOT/node_modules/@getpaseo/cli"
DIST="$PKG/dist/index.js"
export PASEO_HOME="\${PASEO_HOME:-$TEST_ROOT}"
exec "$HOME/.bun/bin/bun" "$DIST" "$@"
`;

function makeEnvHome(root, { withCliEntry }) {
  const home = join(root, "paseo/TEST");
  mkdirSync(join(home, "node_modules/@getpaseo/server/dist"), { recursive: true });
  mkdirSync(join(home, "node_modules/zod"), { recursive: true });
  writeFileSync(join(home, "paseo-bun"), LAUNCHER);
  writeFileSync(join(home, "node_modules/zod/package.json"), '{"name":"zod","main":"index.js"}');
  writeFileSync(join(home, "node_modules/zod/index.js"), "export const z = 1;\n");
  writeFileSync(
    join(home, "node_modules/@getpaseo/server/dist/index.js"),
    'import { z } from "zod";\nexport const v = z;\n',
  );
  if (withCliEntry) {
    mkdirSync(join(home, "node_modules/@getpaseo/cli/dist"), { recursive: true });
    writeFileSync(join(home, "node_modules/@getpaseo/cli/dist/index.js"), "export const e = 1;\n");
  }
  return home;
}

function hasBun() {
  return spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
}

test("both deploy loops ship the cli dist the daemon launches", () => {
  const loops = [...readFileSync(pipeline, "utf8").matchAll(/for pkg in ([^;]+); do/g)].map(
    (match) => match[1].trim().split(/\s+/),
  );
  assert.ok(loops.length >= 2, `expected a deploy loop per env, found ${loops.length}`);
  for (const packages of loops) {
    assert.ok(
      packages.includes("cli"),
      `deploy loop omits 'cli' — the daemon entry would never be copied: ${packages.join(" ")}`,
    );
  }
});

test("the pipeline still builds the cli it now deploys", () => {
  assert.match(
    readFileSync(pipeline, "utf8"),
    /build --workspace=@getpaseo\/cli/,
    "the cli build step must stay in place",
  );
});

test("closure gate no longer excludes cli wholesale", () => {
  const source = readFileSync(verifier, "utf8");
  const excluded = source.match(/const EXCLUDED_SUBTREES = new Set\(\[([^\]]*)\]/s);
  assert.ok(excluded, "EXCLUDED_SUBTREES must stay a literal set");
  const entries = [...excluded[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(
    !entries.includes("cli"),
    "'cli' must not be excluded — it is deployed and is daemon-reachable",
  );
});

test("closure gate asserts the daemon entry point exists", () => {
  const source = readFileSync(verifier, "utf8");
  assert.match(source, /MISSING DAEMON ENTRY POINT/, "entry-point failure must be reported");
  assert.match(source, /resolveLauncherEntry/, "entry target must come from the launcher");
  // The dist scan can never see a missing package; the entry check must run
  // before the walk is invoked (the walk itself is hoisted, hence the call site).
  assert.ok(
    source.indexOf("MISSING DAEMON ENTRY POINT") < source.indexOf("walk(dist,"),
    "entry check must run before the dist walk is invoked",
  );
});

test(
  "gate fails when the launcher target is absent",
  { skip: hasBun() ? false : "bun (the daemon runtime) is not on PATH" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "paseo-closure-missing-"));
    try {
      const home = makeEnvHome(root, { withCliEntry: false });
      const run = spawnSync("bun", [verifier, home], {
        encoding: "utf8",
        env: { ...process.env, HOME: root },
      });
      assert.equal(run.status, 1, `expected exit 1, got ${run.status}: ${run.stderr}`);
      assert.match(run.stderr, /MISSING DAEMON ENTRY POINT/);
      // The reported path must be the launcher's target, resolved via $HOME.
      const expected = join(home, "node_modules/@getpaseo/cli/dist/index.js");
      assert.match(run.stderr, new RegExp(`MISSING DAEMON ENTRY POINT: ${expected}`));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "gate passes when the launcher target is present",
  { skip: hasBun() ? false : "bun (the daemon runtime) is not on PATH" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "paseo-closure-present-"));
    try {
      const home = makeEnvHome(root, { withCliEntry: true });
      const run = spawnSync("bun", [verifier, home], {
        encoding: "utf8",
        env: { ...process.env, HOME: root },
      });
      assert.equal(run.status, 0, `expected exit 0, got ${run.status}: ${run.stderr}`);
      assert.match(run.stdout, /runtime closure resolves/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "gate honours the launcher's own target, not a hardcoded path",
  { skip: hasBun() ? false : "bun (the daemon runtime) is not on PATH" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "paseo-closure-custom-"));
    try {
      const home = makeEnvHome(root, { withCliEntry: true });
      // Move the entry file somewhere the default path would not find it.
      const relocated = join(root, "elsewhere/entry.js");
      mkdirSync(join(root, "elsewhere"), { recursive: true });
      writeFileSync(relocated, "export const e = 1;\n");
      rmSync(join(home, "node_modules/@getpaseo/cli/dist/index.js"));
      writeFileSync(
        join(home, "paseo-bun"),
        LAUNCHER.replace('DIST="$PKG/dist/index.js"', `DIST="$TEST_ROOT/../../elsewhere/entry.js"`),
      );
      const run = spawnSync("bun", [verifier, home], {
        encoding: "utf8",
        env: { ...process.env, HOME: root },
      });
      assert.equal(run.status, 0, `expected exit 0, got ${run.status}: ${run.stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
