// fleet-merge-safety.mjs — CI-enforced merge-safety rules for paseo#31.
//
// Rule 1 (#31: "a plugins/* commit touching packages/* -> build fails"):
//   fails when the changeset touches files under BOTH plugins/ and packages/.
// Rule 2 (#31: "@tursodatabase/database may only be imported from
//   store/turso-repository.ts"): fails on any other importer in the package.
//   SUBSTRING match on the forbidden name (not an anchored ^prefix): a
//   node_modules-prefixed specifier (../node_modules/@tursodatabase/...) must
//   also fire. Matcher + extension set + allowlist MUST stay identical to
//   packages/fleet-backend/tests/gates/turso-import.test.ts.
//
// Rule 3 (owner decision 2026-10-05, "version stamping is KEPT-VIA-SCRIPT"):
//   the fork version stamp is reproduced by running
//   scripts/sync-workspace-versions.mjs, never re-applied by hand during the merge.
//   Fails when that script is missing, is upstream's non-stamping copy, carries an
//   identifier other than "hub", no longer runs, or has not been run against this
//   tree. Delegates to scripts/check-fork-version-stamp.mjs so there is exactly one
//   implementation of the rule.
//
// Usage:
//   node scripts/fleet-merge-safety.mjs --base <sha> --head <sha>
//   node scripts/fleet-merge-safety.mjs --files $'a\nb\nc'   (porcelain list)
//   node scripts/fleet-merge-safety.mjs --check-turso-only
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

const ROOT = path.dirname(new URL(".", import.meta.url).pathname.replace(/\/$/, ""));

function changedFiles(base, head) {
  const out = execFileSync("git", ["diff", "--name-only", `${base}...${head}`, "--"], {
    encoding: "utf-8",
    cwd: ROOT,
  });
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function checkMergeSafety(files) {
  const plugins = files.filter((f) => f === "plugins" || f.startsWith("plugins/"));
  const packages = files.filter((f) => f === "packages" || f.startsWith("packages/"));
  if (plugins.length && packages.length) {
    return {
      ok: false,
      message:
        `merge-safety: changeset touches BOTH plugins/ (${plugins.length}) and packages/ (${packages.length}) — ` +
        `a plugins/* commit must never touch packages/* (paseo#31).\n` +
        `plugins: ${plugins.slice(0, 10).join(", ")}\npackages: ${packages.slice(0, 10).join(", ")}`,
    };
  }
  return { ok: true };
}

function collectFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (
      entry === "node_modules" ||
      entry === "dist" ||
      entry === ".tmp" ||
      entry === ".fixture-tmp"
    )
      continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectFiles(full, out);
    else if (
      /\.(ts|mts|js|mjs|cjs)$/.test(entry) &&
      !entry.endsWith(".d.ts") &&
      !entry.endsWith(".d.ts.map")
    )
      out.push(full);
  }
  return out;
}

function checkTursoImport() {
  const pkg = path.join(ROOT, "packages", "fleet-backend");
  if (!existsSync(pkg)) return { ok: true, skipped: true };
  // Allowlist MUST stay identical to tests/gates/turso-import.test.ts. The
  // fixture-regen script is a MANUAL op (never CI/tests); it opens a
  // disposable sqlite copy, so it holds a narrow exception to the rule.
  const allowed = new Set([
    path.join(pkg, "src", "store", "turso-repository.ts"),
    path.join(pkg, "scripts", "regenerate-fixture.mjs"),
  ]);
  const offenders = [];
  for (const file of collectFiles(pkg)) {
    const text = readFileSync(file, "utf-8");
    // SUBSTRING match on the forbidden package name: also fires on
    // node_modules-prefixed specifiers (../node_modules/@tursodatabase/...).
    // Keep in sync with tests/gates/turso-import.test.ts.
    if (
      /(?:from\s+['"]|import\s*\(\s*['"]|require\s*\(\s*['"])[^'"]*@tursodatabase\/database(?:\/[^'"]*)?['"]/.test(
        text,
      )
    ) {
      if (!allowed.has(file)) offenders.push(path.relative(ROOT, file));
    }
  }
  if (offenders.length) {
    return {
      ok: false,
      message:
        `turso-import: @tursodatabase/database must only be imported from ` +
        `packages/fleet-backend/src/store/turso-repository.ts (paseo#31). Offenders: ${offenders.join(", ")}`,
    };
  }
  return { ok: true };
}

// Rule 3 delegates rather than reimplementing: the stamp rule needs to run the
// stamp script against a throwaway replica of the tree, which is too much state
// to carry inside this file. Subprocess keeps one source of truth for the rule
// and lets it print its own remediation.
function checkForkVersionStamp() {
  const check = path.join(ROOT, "scripts", "check-fork-version-stamp.mjs");
  if (!existsSync(check)) {
    return {
      ok: false,
      message:
        "fork-version-stamp: scripts/check-fork-version-stamp.mjs is missing. Rule 3 has no " +
        "implementation, which would make the stamp gate a silent pass. Restore it.",
    };
  }
  try {
    execFileSync(process.execPath, [check], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true };
  } catch (error) {
    const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`.trim();
    return {
      ok: false,
      message: output || `fork-version-stamp: check exited non-zero: ${error?.message ?? error}`,
    };
  }
}

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? "");
};

let failures = 0;
// A sync/integration merge legitimately spans both trees: it copies lanes'
// already-reviewed work into an integration branch. The lane boundary rule
// exists to keep REGULAR lane commits from crossing trees (paseo#31), not to
// block integration.
//
// The override is opt-in and always announced. Do NOT wire this to anything an
// author can set incidentally -- it used to key off `contains(title, 'sync:')`,
// which made the whole gate a no-op for any PR whose title happened to start
// with "sync:" (including the PR that introduced the gate). Requiring a repo
// label means only someone with write access can waive the rule, and the
// waiver is visible in the log instead of reading as a clean PASS.
const allowMixedTree = flag("--allow-mixed-tree") !== null;
if (allowMixedTree) {
  console.log(
    "merge-safety: OVERRIDDEN via --allow-mixed-tree — rule 1 was NOT evaluated.\n" +
      "  Set this only for an integration merge that intentionally spans both trees,\n" +
      "  and say so in the PR body.",
  );
}
function reportTursoImport() {
  const r = checkTursoImport();
  console.log(
    r.ok
      ? `turso-import: PASS${r.skipped ? " (package absent)" : ""}`
      : `turso-import: FAIL\n${r.message}`,
  );
  return r.ok;
}

// --check-turso-only is documented in the usage header above but was never
// read: the invocation fell through to the "no changeset to check" branch and
// exited 1 while printing PASS. Honour it, as the ONLY rule evaluated, and
// decide it before rule 1 so the missing changeset is not also counted.
if (flag("--check-turso-only") !== null) {
  process.exit(reportTursoImport() ? 0 : 1);
}

const hasFiles = flag("--files") !== null;
const hasBase = flag("--base") !== null;
if (!hasFiles && !hasBase) {
  console.error(
    "merge-safety: no changeset to check — pass --base/--head or --files.\n" +
      "  Running with neither silently passes rule 1; that is a hole, not a pass.",
  );
  failures++;
} else if (hasFiles) {
  const files = String(flag("--files"))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const r = allowMixedTree ? { ok: true } : checkMergeSafety(files);
  if (!allowMixedTree) {
    console.log(r.ok ? "merge-safety: PASS" : `merge-safety: FAIL\n${r.message}`);
  }
  if (!r.ok) failures++;
} else {
  const files = changedFiles(flag("--base"), flag("--head") || "HEAD");
  console.log(`merge-safety: ${files.length} changed files`);
  const r = allowMixedTree ? { ok: true } : checkMergeSafety(files);
  if (!allowMixedTree) {
    console.log(r.ok ? "merge-safety: PASS" : `merge-safety: FAIL\n${r.message}`);
  }
  if (!r.ok) failures++;
}
// Rules 2 and 3 scan the WORKING TREE, not the changeset, so nothing about
// --files should suppress them. The old `if (flag("--files") === null)` guard
// made `--files <list>` print "PASS" and exit 0 with a live
// @tursodatabase/database import still in the tree (measured, seeded probe).
if (!reportTursoImport()) failures++;
const stamp = checkForkVersionStamp();
console.log(stamp.ok ? "fork-version-stamp: PASS" : `fork-version-stamp: FAIL\n${stamp.message}`);
if (!stamp.ok) failures++;
process.exit(failures ? 1 : 0);
