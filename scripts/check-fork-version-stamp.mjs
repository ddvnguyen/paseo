// check-fork-version-stamp.mjs — proves the fork's version stamp is KEPT-VIA-SCRIPT.
//
// Owner decision 2026-10-05: the fork version stamp is not re-applied by hand during
// the upstream merge. It is reproduced by RUNNING scripts/sync-workspace-versions.mjs,
// so the thing merge verification has to prove is that the script is present, is the
// fork's variant, and still produces a correct stamp against the merged tree.
//
// The stamp is `<upstream version>-hub-<short sha>-<yyMMDD-HHmm>`, for example
// 0.9.2-hub-6927d72ac0-261003-0950. The identifier is "hub", NOT "hydra": commit
// bf00e8df5 renamed it, and "hydra" survives only as the getHydraTimestamp() helper
// name and the "build-hydra" CI stage. Check 3 guards that rename.
//
// Usage:
//   node scripts/check-fork-version-stamp.mjs
//
// Exit code 0 when every check passes, 1 otherwise.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAMP_SCRIPT = path.join(ROOT, "scripts", "sync-workspace-versions.mjs");
const FORK_IDENTIFIER = "hub";
const REMEDIATION = "run: node scripts/sync-workspace-versions.mjs";

const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const failures = [];

function fail(check, message) {
  failures.push({ check, message });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf-8"));
}

/** Workspace directories, using the same `workspaces` array the stamp script walks. */
function workspaceDirs(rootPkg) {
  return (Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : []).filter(
    (entry) => typeof entry === "string" && existsSync(path.join(ROOT, entry, "package.json")),
  );
}

function internalDeps(pkg) {
  const out = [];
  for (const section of DEP_SECTIONS) {
    const deps = pkg[section];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, range] of Object.entries(deps)) {
      if (name.startsWith("@getpaseo/") && name !== pkg.name) out.push({ section, name, range });
    }
  }
  return out;
}

/** Human-readable list of a package's internal deps that are not on workspace:*. */
function nonWorkspaceDeps(label, pkg) {
  return internalDeps(pkg)
    .filter((dep) => dep.range !== "workspace:*")
    .map((dep) => `${label} ${dep.section}.${dep.name} -> ${dep.range}`);
}

// 1. The script exists.
if (!existsSync(STAMP_SCRIPT)) {
  fail(
    "script-present",
    `scripts/sync-workspace-versions.mjs is missing. The fork version stamp is KEPT-VIA-SCRIPT, ` +
      `so without this script no build produces a -${FORK_IDENTIFIER}-<sha>-<stamp> version. ` +
      `Restore it from the fork side; ${REMEDIATION}`,
  );
}

// 2 + 3. It is the fork's variant, not upstream's, and the identifier is "hub".
if (existsSync(STAMP_SCRIPT)) {
  const text = readFileSync(STAMP_SCRIPT, "utf-8");
  const declared = text.match(/const\s+FORK_IDENTIFIER\s*=\s*["']([^"']+)["']/)?.[1];

  if (!declared) {
    fail(
      "script-is-fork-variant",
      "scripts/sync-workspace-versions.mjs has no FORK_IDENTIFIER constant, so it only syncs the " +
        "plain upstream version and never stamps the fork identity. Upstream's copy of this script " +
        "looks exactly like that; the merge must not resolve this file to the upstream side. " +
        `Restore the fork's copy; ${REMEDIATION}`,
    );
  } else if (declared !== FORK_IDENTIFIER) {
    fail(
      "identifier-is-hub",
      `The fork identifier is "${declared}", expected "${FORK_IDENTIFIER}". Commit bf00e8df5 renamed the ` +
        `suffix from -hydra to -${FORK_IDENTIFIER}; "-hydra" is not a live identifier and a stamp built ` +
        `with it will not match deployed builds. Correct FORK_IDENTIFIER in ` +
        `scripts/sync-workspace-versions.mjs; ${REMEDIATION}`,
    );
  }

  if (declared && !/getHydraTimestamp|getForkTimestamp/.test(text)) {
    fail(
      "script-is-fork-variant",
      "scripts/sync-workspace-versions.mjs declares a fork identifier but never appends the " +
        "<short sha>-<yyMMDD-HHmm> build stamp, so the version is not reproducible per build. " +
        `Restore the fork's copy; ${REMEDIATION}`,
    );
  }
}

// 4. The script still runs against a replica of this tree and produces a correct stamp.
//    Replica rather than the live tree: the script writes to the workspaces it walks, and
//    a verification step must not mutate the checkout it is verifying.
if (existsSync(STAMP_SCRIPT)) {
  const rootPkg = readJson(path.join(ROOT, "package.json"));
  const dirs = workspaceDirs(rootPkg);
  const before = new Map(dirs.map((dir) => [dir, readJson(path.join(ROOT, dir, "package.json"))]));

  let replica;
  try {
    replica = mkdtempSync(path.join(tmpdir(), "paseo-stamp-check-"));
    mkdirSync(path.join(replica, "scripts"), { recursive: true });
    cpSync(STAMP_SCRIPT, path.join(replica, "scripts", "sync-workspace-versions.mjs"));
    writeFileSync(path.join(replica, "package.json"), `${JSON.stringify(rootPkg, null, 2)}\n`);
    for (const dir of dirs) {
      const target = path.join(replica, dir, "package.json");
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(before.get(dir), null, 2)}\n`);
    }
    // The script derives the sha from git; without a repo it falls back to a bare
    // `-hub` suffix and the full stamp shape would go untested.
    const git = (...args) =>
      execFileSync("git", args, { cwd: replica, stdio: ["ignore", "pipe", "ignore"] });
    git("init", "-q", ".");
    git("add", "-A");
    git(
      "-c",
      "user.email=stamp-check@example.invalid",
      "-c",
      "user.name=stamp-check",
      "commit",
      "-qm",
      "replica",
    );

    execFileSync(process.execPath, ["scripts/sync-workspace-versions.mjs"], {
      cwd: replica,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const expected = new RegExp(
      `^${escapeRegExp(rootPkg.version)}-${FORK_IDENTIFIER}-[0-9a-f]{7,40}-\\d{6}-\\d{4}$`,
    );
    const unstamped = [];
    for (const dir of dirs) {
      const stamped = readJson(path.join(replica, dir, "package.json"));
      if (!expected.test(stamped.version)) unstamped.push(`${dir} -> ${stamped.version}`);
    }
    if (unstamped.length) {
      fail(
        "script-runs",
        `The stamp script ran but ${unstamped.length} workspace(s) did not receive a ` +
          `<version>-${FORK_IDENTIFIER}-<sha>-<yyMMDD-HHmm> version:\n  ${unstamped.join("\n  ")}\n` +
          `  ${REMEDIATION}`,
      );
    }

    const unnormalized = [];
    for (const dir of dirs) {
      unnormalized.push(
        ...nonWorkspaceDeps(dir, readJson(path.join(replica, dir, "package.json"))),
      );
    }
    if (unnormalized.length) {
      fail(
        "script-runs",
        `The stamp script ran but left ${unnormalized.length} internal @getpaseo dep(s) on a ` +
          `non-workspace:* range, which pnpm's frozen lockfile will reject:\n  ${unnormalized.join("\n  ")}\n` +
          `  ${REMEDIATION}`,
      );
    }
  } catch (error) {
    fail(
      "script-runs",
      `The stamp script did not run cleanly against a replica of this tree: ${
        error instanceof Error ? error.message : String(error)
      }\n  Upstream changed 119 paths in the merge; if this is a real break, fix the script. ${REMEDIATION}`,
    );
  } finally {
    if (replica) rmSync(replica, { force: true, recursive: true });
  }
}

// 5. The committed half of the script's output is in place: this is the evidence that
//    the script was actually run against this tree, since the ephemeral sha/stamp is
//    never committed.
{
  const rootPkg = readJson(path.join(ROOT, "package.json"));
  const offenders = [];
  for (const dir of workspaceDirs(rootPkg)) {
    offenders.push(...nonWorkspaceDeps(dir, readJson(path.join(ROOT, dir, "package.json"))));
  }
  if (offenders.length) {
    fail(
      "tree-internal-deps-are-workspace",
      `${offenders.length} internal @getpaseo dep(s) are not "workspace:*", so the stamp script has not ` +
        `been run against this tree (an upstream-first merge resolves the workspace package.json files to ` +
        `upstream and replaces these with exact or "*" ranges, which breaks --frozen-lockfile):\n` +
        `  ${offenders.join("\n  ")}\n  ${REMEDIATION}`,
    );
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

for (const { check, message } of failures) {
  console.log(`fork-version-stamp: FAIL [${check}]\n${message}\n`);
}
if (!failures.length) {
  console.log(
    `fork-version-stamp: PASS (identifier -${FORK_IDENTIFIER}, workspaces under \`workspaces\`)`,
  );
}
process.exit(failures.length ? 1 : 0);
