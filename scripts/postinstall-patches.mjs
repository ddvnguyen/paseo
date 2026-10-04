import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";

// In CI we often install a single workspace (e.g. server/relay/website). Only apply patches
// when the patched dependency is actually present.
// `cwd` is where patch-package must run from. Packages that npm does not hoist to the
// workspace root live in their workspace's own node_modules, and patch-package resolves
// the patch's node_modules/... paths relative to its working directory.
const patchedPackages = [
  {
    nodeModulesPath: "node_modules/react-native-markdown-display",
    patchPrefix: "react-native-markdown-display+",
  },
  // Remove after react-native-unistyles ships
  // https://github.com/jpudysz/react-native-unistyles/pull/1203.
  {
    nodeModulesPath: "node_modules/react-native-unistyles",
    patchPrefix: "react-native-unistyles+",
  },
  {
    nodeModulesPath: "node_modules/react-native-draggable-flatlist",
    patchPrefix: "react-native-draggable-flatlist+",
  },
  {
    nodeModulesPath: "node_modules/react-native-gesture-handler",
    patchPrefix: "react-native-gesture-handler+",
  },
  {
    nodeModulesPath: "node_modules/react-native-svg",
    patchPrefix: "react-native-svg+",
  },
  {
    // pnpm keeps react-native-svg inside the app workspace; without this entry
    // the SVG transform hardening never applies and a CSS keyword transform
    // throws at render time.
    nodeModulesPath: "packages/app/node_modules/react-native-svg",
    patchPrefix: "react-native-svg+",
    cwd: "packages/app",
  },
  {
    nodeModulesPath: "node_modules/@mattermost/react-native-paste-input",
    patchPrefix: "@mattermost+react-native-paste-input+",
  },
  {
    nodeModulesPath: "packages/server/node_modules/@opencode-ai/sdk",
    patchPrefix: "@opencode-ai+sdk+",
    cwd: "packages/server",
  },
  {
    nodeModulesPath: "packages/freebuff-acp/node_modules/@codebuff/sdk",
    patchPrefix: "@codebuff+sdk+",
    cwd: "packages/freebuff-acp",
  },
  {
    // Bun hoists workspace deps to the root node_modules; without this entry
    // the OpenCode SDK SSE crash patch silently never applies on bun installs.
    nodeModulesPath: "node_modules/@opencode-ai/sdk",
    patchPrefix: "@opencode-ai+sdk+",
    cwd: ".",
  },
];

const installedPackages = patchedPackages.filter(({ nodeModulesPath }) =>
  existsSync(nodeModulesPath),
);

if (!existsSync("patches") || installedPackages.length === 0) {
  process.exit(0);
}

const patchFiles = readdirSync("patches").filter((file) => file.endsWith(".patch"));

// Group patch files by the directory patch-package must run from. Two entries
// may share a patch prefix for the root and the workspace install; a group only
// runs if the packages it patches are actually installed there, otherwise
// patch-package fails on a path that does not exist.
const patchFilesByCwd = new Map();
for (const { patchPrefix, nodeModulesPath, cwd = "." } of installedPackages) {
  const target = cwd === "." ? nodeModulesPath : relative(".", nodeModulesPath);
  if (!existsSync(target)) continue;
  const files = patchFiles.filter((file) => file.startsWith(patchPrefix));
  if (files.length === 0) {
    continue;
  }
  const group = patchFilesByCwd.get(cwd) ?? [];
  group.push(...files);
  patchFilesByCwd.set(cwd, group);
}

if (patchFilesByCwd.size === 0) {
  process.exit(0);
}

const isWindows = process.platform === "win32";
const cmd = isWindows ? "patch-package.cmd" : "patch-package";

let groupIndex = 0;
for (const [cwd, files] of patchFilesByCwd) {
  groupIndex += 1;
  const tempPatchDir = join(".tmp", `postinstall-patches-${process.pid}-${groupIndex}`);

  mkdirSync(tempPatchDir, { recursive: true });
  // patch-package resolves a patch's node_modules/... paths relative to its cwd,
  // which is exactly what the workspace entries need: the same patch file works
  // from the root install and from a workspace's own node_modules.
  for (const patchFile of files) {
    copyFileSync(join("patches", patchFile), join(tempPatchDir, patchFile));
  }

  let result;
  try {
    // Resolve node_modules/.bin explicitly: npm run adds it to PATH, but bun
    // lifecycle hooks do not, which made every bun install skip the patches.
    const binDir = join(process.cwd(), "node_modules", ".bin");
    const pathSep = isWindows ? ";" : ":";
    result = spawnSync(cmd, ["--patch-dir", relative(cwd, tempPatchDir)], {
      cwd,
      shell: isWindows,
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, PATH: `${binDir}${pathSep}${process.env.PATH ?? ""}` },
    });
  } finally {
    rmSync(tempPatchDir, { recursive: true, force: true });
  }

  if (result.error) {
    console.error("postinstall-patches: patch-package failed to spawn:", result.error.message);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

process.exit(0);
