import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const repoRoot = join(import.meta.dirname, "..");

// Bumping the runtime means changing this literal AND .tool-versions. That is the
// point: the pin should be a deliberate two-place edit, never a silent drift.
const EXPECTED_BUN_VERSION = "1.4.2";

async function read(...parts) {
  return readFile(join(repoRoot, ...parts), "utf8");
}

/** Extract the body of a `cat > "..." <<'EOF' ... EOF` heredoc from a script. */
function extractHeredoc(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `could not find launcher marker: ${marker}`);
  const afterMarker = source.slice(start);
  const bodyStart = afterMarker.indexOf("<<'EOF'\n");
  assert.notEqual(bodyStart, -1, `no quoted heredoc after marker: ${marker}`);
  const body = afterMarker.slice(bodyStart + "<<'EOF'\n".length);
  const end = body.indexOf("\nEOF\n");
  assert.notEqual(end, -1, `unterminated heredoc after marker: ${marker}`);
  return body.slice(0, end);
}

test(".tool-versions pins bun to exactly one version", async () => {
  const toolVersions = await read(".tool-versions");
  const bunLines = toolVersions
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[0] === "bun");

  assert.equal(bunLines.length, 1, `expected exactly one bun pin, got ${bunLines.length}`);
  assert.equal(
    bunLines[0][1],
    EXPECTED_BUN_VERSION,
    `.tool-versions pins bun ${bunLines[0][1]}, this test expects ${EXPECTED_BUN_VERSION}`,
  );
});

test("the pnpm pin is untouched and does not collide with the bun pin", async () => {
  const pkg = JSON.parse(await read("package.json"));

  // `packageManager` is corepack's package-manager slot: it can only name one
  // manager. pnpm keeps it. Putting bun there would break `pnpm install`.
  assert.match(
    pkg.packageManager ?? "",
    /^pnpm@\d+\.\d+\.\d+$/,
    `packageManager must stay a pnpm pin, got ${pkg.packageManager}`,
  );
  assert.doesNotMatch(pkg.packageManager ?? "", /bun/);

  // The install contract is pnpm's alone -- no runtime may be smuggled into it.
  assert.doesNotMatch(pkg.scripts?.postinstall ?? "", /\bbun\b/);
});

test("the enforcer reads the pin instead of hardcoding a version", async () => {
  const helper = await read("scripts", "bun-runtime.sh");

  assert.match(helper, /awk '\$1 == "bun"/, "must read the bun version out of .tool-versions");

  // A literal version in executable code would be a second source of truth. Comments
  // may mention the current version -- they are prose, not behaviour.
  const code = helper
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(
    code,
    /\b1\.4\.\d+\b/,
    "bun-runtime.sh executable code must not hardcode a version; it reads .tool-versions",
  );

  // The two failure modes the pin exists to prevent.
  assert.match(helper, /version mismatch/, "must detect a version mismatch");
  assert.match(helper, /refusing to fall back to node/, "must state that it will not fall back");
});

test("both generated systemd launchers assert the pinned version", async () => {
  const consolidate = await read("deploy", "consolidate-paseo-home.sh");

  // The launchers live outside the checkout, so they cannot read .tool-versions at
  // run time. The version must be substituted in from the pin, not hand-written.
  assert.match(
    consolidate,
    /source "\$SCRIPT_DIR\/\.\.\/scripts\/bun-runtime\.sh"/,
    "consolidate must source the enforcer so the pin is the source of truth",
  );
  assert.match(
    consolidate,
    /BUN_VERSION="\$\(paseo_required_bun_version\)"/,
    "consolidate must read the pinned version through the enforcer",
  );

  for (const [marker, label] of [
    ["# Rewrite the PROD launcher", "PROD"],
    ["# Rewrite the TEST launcher", "TEST"],
  ]) {
    const launcher = extractHeredoc(consolidate, marker);
    assert.match(
      launcher,
      /REQUIRED_BUN_VERSION="__PASEO_BUN_VERSION__"/,
      `${label} launcher must take its version from the generation-time substitution`,
    );
    assert.match(launcher, /--version/, `${label} launcher must read the runtime's version`);
    assert.match(
      launcher,
      /refusing to fall back to node/,
      `${label} launcher must refuse rather than fall back to node`,
    );
    assert.doesNotMatch(launcher, /\bexec node\b/, `${label} launcher must never exec node`);
  }

  // The substitution has to actually happen for both files.
  const substitutions = consolidate.match(/__PASEO_BUN_VERSION__/g) ?? [];
  assert.ok(
    substitutions.length >= 2,
    `expected a substitution in each launcher, found ${substitutions.length}`,
  );
  const sedCalls = consolidate.match(/sed -i "s\/__PASEO_BUN_VERSION__\/\$BUN_VERSION\/"/g) ?? [];
  assert.equal(sedCalls.length, 2, "both launchers must substitute the pinned version");
});

test("every systemd unit reaches the daemon through the pinned runtime", async () => {
  for (const unit of ["paseo.service", "paseo-test.service"]) {
    const source = await read("deploy", "systemd", unit);
    // The runtime is asserted inside the paseo-bun launcher these units exec, not
    // inline, so the unit only has to route through it. The launcher ends in
    // `exec "$BUN" "$DIST" "$@"`, so it checks the pinned version before handing
    // off and passes the arguments through untouched: which daemon subcommand
    // follows paseo-bun does not change the runtime that starts.
    //
    // PR #59 moved these units from `daemon start --foreground --listen ...` to
    // `daemon run --home <tier>`, keeping paseo-bun in place. The subcommand is
    // pinned rather than loosened because it is load-bearing under Type=simple:
    // `daemon run` is the foreground form, whereas a bare `daemon start` launches
    // the daemon managed and non-foreground, which the unit's supervision model
    // does not want. The backreference ties --home to the same tier as the
    // launcher so a PROD launcher cannot be paired with TEST state.
    assert.match(
      source,
      /^ExecStart=%h\/paseo\/(PROD|TEST)\/paseo-bun daemon run --home %h\/paseo\/\1$/m,
      `${unit} must start the daemon via the paseo-bun launcher`,
    );
    assert.doesNotMatch(source, /ExecStart=.*\bnode\b/, `${unit} must not exec node directly`);
  }

  const fleet = await read("deploy", "fleet-backend.service");
  assert.doesNotMatch(
    fleet,
    /ExecStart=[^\n]*\bnode\b/,
    "fleet-backend.service must not exec node directly",
  );
  assert.match(fleet, /ExecStart=[^\n]*\bbun\b/, "fleet-backend.service must exec bun");
  // The assertion lives in ExecStartPre because this unit has no launcher script.
  assert.match(
    fleet,
    /ExecStartPre=[^\n]*--version[^\n]*1\.4\.2|ExecStartPre=[\s\S]*?--version[\s\S]*?1\.4\.2/,
    "fleet-backend.service must assert the pinned bun version before starting",
  );
});

test("CI installs and proves the same bun the pin names", async () => {
  const workflow = await read(".github", "workflows", "ci.yml");

  // The workflow cannot read .tool-versions (setup-bun takes a literal), so that
  // literal is a second place the version appears. Tie the two together here.
  assert.match(
    workflow,
    /oven-sh\/setup-bun@v[0-9]+/,
    "the bun-runtime job must install bun via setup-bun",
  );
  assert.match(
    workflow,
    new RegExp(`bun-version:\\s*"${EXPECTED_BUN_VERSION.replace(/\./g, "\\.")}"`),
    `CI installs a bun other than the pinned ${EXPECTED_BUN_VERSION}`,
  );

  // The job has to actually run the proof, not just install bun.
  assert.match(workflow, /verify-bun-runtime\.sh/, "the bun-runtime job must run the proof script");

  // And the contract test that guards all of this must itself be wired into CI.
  assert.match(
    workflow,
    /runtime-pin\.test\.mjs/,
    "runtime-pin.test.mjs must run in the Validate CI contracts step",
  );

  // The route that triggers the job has to include the pin file, or a PR that
  // only moves the version would skip the job that proves it.
  const ciPaths = await read(".github", "ci-paths.yml");
  assert.match(ciPaths, /bun-runtime:/, "ci-paths.yml must define the bun-runtime route");
  assert.match(
    ciPaths.split("bun-runtime:")[1],
    /"\.tool-versions"/,
    "the bun-runtime route must include .tool-versions",
  );
});

test("the dev launcher runs the daemon on the asserted bun", async () => {
  const devDaemon = await read("scripts", "dev-daemon.sh");

  assert.match(devDaemon, /paseo_assert_bun/, "dev must assert the pin before starting");
  // Without this the assertion is decorative: the package scripts call `bun` by
  // name, so they could resolve a different binary than the one just verified.
  assert.match(
    devDaemon,
    /export PATH="\$\(dirname "\$BUN_BIN"\):\$PATH"/,
    "dev must put the asserted binary ahead of any other bun on PATH",
  );

  const devHome = await read("scripts", "dev-home.sh");
  assert.doesNotMatch(devHome, /\bnode -e\b/, "the dev config writer must not shell out to node");

  const serverPkg = JSON.parse(await read("packages", "server", "package.json"));
  assert.match(
    serverPkg.scripts.dev,
    /\bbun\b/,
    `packages/server dev must run on bun, got: ${serverPkg.scripts.dev}`,
  );
  assert.match(
    serverPkg.scripts.start,
    /\bbun\b/,
    `packages/server start must run on bun, got: ${serverPkg.scripts.start}`,
  );
  assert.doesNotMatch(serverPkg.scripts.start, /\bnode\b/);
});
