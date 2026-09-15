// Verify every external import in the deployed @getpaseo dists resolves
// from the env's node_modules — using Bun's resolver (the daemon runtime).
// Usage: bun verify-closure.bun.mjs <ENV_HOME>
// Fails (exit 1) listing unresolvable specifiers, e.g. a new dist shipped
// without its runtime dep installed (the semver outage class).
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { builtinModules } from "node:module";

const home = process.argv[2] ?? process.cwd();
const scope = join(home, "node_modules/@getpaseo");
const builtins = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));

// Only daemon-reachable dists: cli/ is NOT deployed by this pipeline
// (stale leftover where present); plugin/dist/client and
// server/dist/server/web-ui are browser bundles served statically —
// their deps ship via the web build, not node_modules.
const EXCLUDED_SUBTREES = new Set(["cli", "plugin/dist/client", "server/dist/server/web-ui"]);

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
