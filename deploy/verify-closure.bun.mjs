// Verify every external import in the deployed @getpaseo dists resolves
// from the env's node_modules — using Bun's resolver (the daemon runtime).
// Usage: bun verify-closure.bun.mjs <ENV_HOME>
// Fails (exit 1) listing unresolvable specifiers, e.g. a new dist shipped
// without its runtime dep installed (the semver outage class).
// Also asserts the daemon's entry file exists, which the dist scan cannot
// detect: an absent package has no dist to walk, so it reads as "nothing to
// check" rather than "the daemon cannot start".
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { builtinModules } from "node:module";

const home = process.argv[2] ?? process.cwd();
const scope = join(home, "node_modules/@getpaseo");
const builtins = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));

// Subtrees the daemon never loads at runtime, so their imports are not part of
// the daemon's resolvable closure. Entries are pkg-relative and may name either
// a directory or a single file.
//
// - plugin/dist/client and server/dist/server/web-ui are browser bundles
//   served statically; their deps ship via the web build, not node_modules.
// - cli/dist/commands/plugin/scaffold.js is the plugin scaffolder. Its
//   react / react-native / @tanstack/react-query "imports" are text inside the
//   template literals it writes into a *generated* plugin project — that
//   project gets its own package.json listing them as devDependencies. They
//   are not imports this daemon ever resolves, so scanning them reports a
//   closure break that does not exist.
//
// `cli` itself IS deployed and IS scanned. It was excluded here on the belief
// that "cli/ is NOT deployed by this pipeline" — a comment asserting a fact
// with nothing behind it. That belief is what let a deploy that built the cli
// and never copied it pass this gate.
const EXCLUDED_SUBTREES = new Set([
  "plugin/dist/client",
  "server/dist/server/web-ui",
  "cli/dist/commands/plugin/scaffold.js",
]);

const specs = new Set();
const re = /(?:require\(\s*|from\s+|import\(\s*|await\s+import\(\s*)["']([^"']+)["']/g;

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
}

function walk(dir, rel) {
  if (EXCLUDED_SUBTREES.has(rel)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (EXCLUDED_SUBTREES.has(entryRel)) continue;
    if (entry.isDirectory()) {
      walk(full, entryRel);
    } else if (/\.[cm]?js$/.test(entry.name)) {
      const src = stripComments(readFileSync(full, "utf8"));
      let m;
      while ((m = re.exec(src)) !== null) {
        const spec = m[1];
        if (/[<>\s*!?{}[\]]/.test(spec)) continue; // not a module specifier
        specs.add(spec);
      }
    }
  }
}

// --- Daemon entry point -----------------------------------------------------
// The daemon is started THROUGH the cli, not through the server:
//   deploy/systemd/paseo-test.service -> ExecStart=%h/paseo/TEST/paseo-bun daemon start ...
//   deploy/consolidate-paseo-home.sh  -> PKG="$ROOT/node_modules/@getpaseo/cli"
//                                         DIST="$PKG/dist/index.js"
//                                         exec bun "$DIST" "$@"
// so cli/dist/index.js is the first file the daemon loads, and if it is absent
// the daemon crash-loops with `Module not found .../cli/dist/index.js`.
//
// The dist scan above structurally cannot catch that: a missing dist means the
// walk has nothing to walk, and `walk` skips unreadable dirs rather than
// reporting them. Assert the launcher's target exists — reading the real
// target out of this env's launcher so the check tracks the launcher rather
// than a hardcoded path, falling back to the conventional cli entry location.
const FALLBACK_ENTRY = join(scope, "cli", "dist", "index.js");

// Resolve the launcher target without executing anything: read `NAME=value`
// assignments in order, expanding `$VAR` against $HOME and earlier assignments.
// Non-assignment lines (shebang, `set -euo`, `exec`, `export FOO=`) are skipped,
// never run.
function resolveLauncherEntry(launcherPath) {
  let src;
  try {
    src = readFileSync(launcherPath, "utf8");
  } catch {
    return null; // no launcher in this home (CI builds a bare node_modules tree)
  }
  const vars = { HOME: process.env.HOME };
  for (const line of src.split("\n")) {
    const assignment = /^\s*([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s#]*)/.exec(line);
    if (!assignment) continue;
    const value = assignment[2]
      .replace(/^["']|["']$/g, "")
      .replace(
        /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
        (_, braced, bare) => vars[braced ?? bare] ?? "",
      );
    vars[assignment[1]] = value;
  }
  // Only trust a target that expanded to an absolute path; $HOME must have been
  // available for that expansion to mean anything.
  return vars.HOME && vars.DIST?.startsWith("/") ? vars.DIST : null;
}

const launcher = join(home, "paseo-bun");
const launcherEntry = resolveLauncherEntry(launcher);
const entry = launcherEntry ?? FALLBACK_ENTRY;
if (!existsSync(entry)) {
  const source = launcherEntry
    ? `read from ${launcher}`
    : `no launcher at ${launcher}; assuming the conventional cli entry path`;
  console.error(
    `MISSING DAEMON ENTRY POINT: ${entry}\n` +
      `The daemon starts through the cli launcher; this file is what it execs\n` +
      `(target ${source}). Deploy packages/cli/dist into\n` +
      `${join(scope, "cli", "dist")} — otherwise the daemon dies with\n` +
      `  Module not found ${entry}`,
  );
  process.exit(1);
}

for (const pkg of readdirSync(scope)) {
  if (EXCLUDED_SUBTREES.has(pkg)) continue;
  const dist = join(scope, pkg, "dist");
  if (!existsSync(dist)) continue;
  walk(dist, `${pkg}/dist`);
}

const externals = [...specs].filter((s) => {
  if (s.startsWith(".") || s.startsWith("/") || s.startsWith("@getpaseo/")) return false;
  const root = s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0];
  return !builtins.has(s) && !builtins.has(root);
});

const missing = [];
for (const spec of externals.sort()) {
  try {
    Bun.resolveSync(spec, home);
  } catch {
    missing.push(spec);
  }
}

if (missing.length > 0) {
  console.error(`UNRESOLVED RUNTIME IMPORTS (${missing.length}):\n${missing.join("\n")}`);
  process.exit(1);
}
console.log(
  `runtime closure resolves (${externals.length} external imports across @getpaseo dists)`,
);
