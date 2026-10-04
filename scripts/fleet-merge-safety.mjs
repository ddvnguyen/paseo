// fleet-merge-safety.mjs — CI-enforced merge-safety rules for paseo#31.
//
// Rule 1 (#31: "a plugins/* commit touching packages/* -> build fails"):
//   fails when the changeset touches files under BOTH plugins/ and packages/.
// Rule 2 (#31: "@tursodatabase/database may only be imported from
//   store/turso-repository.ts"): fails on any other importer in the package.
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
    else if (/\.(ts|mts|js|mjs|cjs)$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function checkTursoImport() {
  const pkg = path.join(ROOT, "packages", "fleet-backend");
  if (!existsSync(pkg)) return { ok: true, skipped: true };
  const allowed = new Set([path.join(pkg, "src", "store", "turso-repository.ts")]);
  const offenders = [];
  for (const file of collectFiles(pkg)) {
    const text = readFileSync(file, "utf-8");
    if (/(?:from\s+['"]|import\s*\(\s*['"])@tursodatabase\/database(?:\/[^'"]*)?['"]/.test(text)) {
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

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? "");
};

let failures = 0;
// A sync/integration merge legitimately spans both trees: it copies lanes'
// already-reviewed work into an integration branch. The lane boundary rule
// exists to keep REGULAR lane commits from crossing trees (paseo#31), not to
// block integration. Gate it behind an explicit flag so it cannot be parked
// accidentally.
const allowMixedTree = flag("--allow-mixed-tree") !== null;
if (flag("--files") !== null) {
  const files = String(flag("--files"))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const r = allowMixedTree ? { ok: true } : checkMergeSafety(files);
  console.log(r.ok ? "merge-safety: PASS" : `merge-safety: FAIL\n${r.message}`);
  if (!r.ok) failures++;
} else if (flag("--base") !== null) {
  const files = changedFiles(flag("--base"), flag("--head") || "HEAD");
  console.log(`merge-safety: ${files.length} changed files`);
  const r = allowMixedTree ? { ok: true } : checkMergeSafety(files);
  console.log(r.ok ? "merge-safety: PASS" : `merge-safety: FAIL\n${r.message}`);
  if (!r.ok) failures++;
}
if (flag("--files") === null) {
  const r = checkTursoImport();
  console.log(
    r.ok
      ? `turso-import: PASS${r.skipped ? " (package absent)" : ""}`
      : `turso-import: FAIL\n${r.message}`,
  );
  if (!r.ok) failures++;
}
process.exit(failures ? 1 : 0);
