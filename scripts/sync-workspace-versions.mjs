import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const rootPackagePath = path.join(rootDir, "package.json");

function getGitCommitShortHash() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function getHydraTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const yy = String(now.getFullYear()).slice(-2);
  return `${yy}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
}

// Fork identifier lives here, not in package.json's "version" field: that
// field is also written by upstream on every release, so a fork suffix
// stored there gets silently dropped on the next `git merge upstream/main`
// that takes upstream's version line. Keeping it as a constant in this
// fork-only script means merges either apply this hunk cleanly or conflict
// loudly — they never silently erase the fork identity.
const FORK_IDENTIFIER = "hub";

const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"));
// Strip a redundant fork suffix if package.json still carries one (defensive,
// covers the transition away from hardcoding it there and any future
// accidental re-additions) so we never double up as "-hub-hub".
const rootVersion = rootPackage.version.replace(new RegExp(`-${FORK_IDENTIFIER}$`), "");
const gitHash = getGitCommitShortHash();
const versionWithHash = gitHash
  ? `${rootVersion}-${FORK_IDENTIFIER}-${gitHash}-${getHydraTimestamp()}`
  : `${rootVersion}-${FORK_IDENTIFIER}`;
const workspacePaths = Array.isArray(rootPackage.workspaces) ? rootPackage.workspaces : [];
const sharedMetadata = {
  homepage: rootPackage.homepage,
  repository: rootPackage.repository,
  author: rootPackage.author,
  license: rootPackage.license,
};

if (typeof rootVersion !== "string" || rootVersion.length === 0) {
  throw new Error('Root package.json must contain a valid "version"');
}

const dependencySections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const touched = [];

for (const workspacePath of workspacePaths) {
  const packagePath = path.join(rootDir, workspacePath, "package.json");
  if (!existsSync(packagePath)) {
    continue;
  }

  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  let changed = false;

  if (pkg.version !== versionWithHash) {
    if (!gitHash && pkg.version.includes(`-${FORK_IDENTIFIER}-`)) {
      // Persisted build dir has no git history, keep the already-stamped version from build-hydra
    } else {
      pkg.version = versionWithHash;
      changed = true;
    }
  }

  if (pkg.name === "@getpaseo/desktop") {
    for (const [field, value] of Object.entries(sharedMetadata)) {
      const currentValue = JSON.stringify(pkg[field]);
      const nextValue = JSON.stringify(value);
      if (currentValue !== nextValue) {
        pkg[field] = value;
        changed = true;
      }
    }
  }

  // All workspaces use "workspace:*" for internal deps under pnpm so the lockfile
  // stays stable across version stamps. The stamped version is only for the
  // package's own "version" field; deps stay as workspace:* for frozen installs.
  const internalDepRange = "workspace:*";
  const isAlreadyStamped = (v) => typeof v === "string" && v.includes(`-${FORK_IDENTIFIER}-`) && v !== `${rootVersion}-${FORK_IDENTIFIER}`;

  for (const section of dependencySections) {
    const deps = pkg[section];
    if (!deps || typeof deps !== "object") {
      continue;
    }

    for (const name of Object.keys(deps)) {
      if (!name.startsWith("@getpaseo/")) {
        continue;
      }
      if (name === pkg.name) {
        continue;
      }
      if (deps[name] !== internalDepRange) {
        if (!gitHash && isAlreadyStamped(deps[name])) {
          // Keep already-stamped dep version when git not available
        } else {
          deps[name] = internalDepRange;
          changed = true;
        }
      }
    }
  }

  if (changed) {
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    touched.push(path.relative(rootDir, packagePath));
  }
}

if (touched.length === 0) {
  console.log(`Workspace versions and internal deps already synced to ${versionWithHash}`);
} else {
  console.log(`Synced to ${versionWithHash}:`);
  for (const file of touched) {
    console.log(`- ${file}`);
  }
}
