#!/usr/bin/env node
/**
 * build-web-ui.mjs — Standalone web UI build for independent deployment.
 *
 * Builds the Expo web app and outputs a self-contained static bundle to
 * dist/web-ui/ at the repo root. This bundle is served by any static file
 * server (Caddy, http-server, etc.) independently of the daemon process.
 *
 * Usage:
 *   node scripts/build-web-ui.mjs
 *
 * Output: dist/web-ui/
 *
 * The daemon must be started with --no-web-ui when this standalone bundle
 * is used. Clients connect to the daemon via the "Add host" flow in the
 * web UI (no connection hint injection needed).
 */
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { constants as zlibConstants, createBrotliCompress, createGzip } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const APP_DIR = path.join(REPO_ROOT, "packages", "app");
const SOURCE_DIST = path.join(APP_DIR, "dist");
const TARGET_DIST = path.join(REPO_ROOT, "dist", "web-ui");
const COMPRESS_EXTENSIONS = new Set([".html", ".js", ".css", ".json", ".svg", ".map"]);

function fmtMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function run(command, runArgs, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, runArgs, {
      stdio: "inherit",
      shell: false,
      ...options,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed with exit code ${code}: ${command} ${runArgs.join(" ")}`));
        return;
      }
      resolve();
    });
  });
}

async function exportBrowserWebApp() {
  console.log("Exporting browser web app...");
  await run("npm", ["run", "build:web", "--workspace=@getpaseo/app"], {
    cwd: REPO_ROOT,
  });
}

async function cleanTarget() {
  console.log(`Cleaning ${path.relative(REPO_ROOT, TARGET_DIST)}...`);
  await rm(TARGET_DIST, { recursive: true, force: true });
  await mkdir(TARGET_DIST, { recursive: true });
}

async function copyAssets() {
  console.log(`Copying assets to ${path.relative(REPO_ROOT, TARGET_DIST)}...`);
  await cp(SOURCE_DIST, TARGET_DIST, { recursive: true, force: true });
}

// sw.js is copied verbatim from packages/app/public/ by the Expo export, so its
// own bytes never change between deploys that only touch static assets (icons,
// manifest). Browsers only re-run the SW "install" handler (and thus
// re-precache PRECACHE_URLS) when the SW script's bytes change, so a static
// CACHE_VERSION literal in the source file would leave every returning
// visitor stuck on stale precached icons/manifest forever. Stamping the
// version here, at build time, forces a fresh SW + cache on every deploy
// without anyone needing to remember to bump it.
//
// Deliberately read the already-stamped packages/app/package.json version
// instead of shelling out to `git rev-parse HEAD`: deploy-web/deploy-test
// build from a persisted build directory (see "Persist build" in the CI
// workflow) that excludes .git and re-inits an empty repo with no commits,
// so `git` would have nothing to resolve there. This app workspace's version
// is written earlier, during build-hydra, by
// scripts/sync-workspace-versions.mjs while the real .git is still present,
// and that stamped value survives the copy. (The root package.json's own
// version field is never rewritten by that script — only each workspace's
// is — so it can't be used here.)
async function stampServiceWorkerCacheVersion() {
  const swPath = path.join(TARGET_DIST, "sw.js");
  const swStat = await stat(swPath).catch(() => null);
  if (!swStat?.isFile()) {
    return;
  }

  const appPackage = JSON.parse(await readFile(path.join(APP_DIR, "package.json"), "utf8"));
  const cacheVersion = appPackage.version;
  if (typeof cacheVersion !== "string" || cacheVersion.length === 0) {
    console.warn("Could not resolve packages/app/package.json version; leaving sw.js unstamped.");
    return;
  }

  const source = await readFile(swPath, "utf8");
  const stamped = source.replace(
    /const CACHE_VERSION = "[^"]*";/,
    `const CACHE_VERSION = "${cacheVersion}";`,
  );
  if (stamped === source) {
    console.warn("sw.js CACHE_VERSION marker not found; leaving sw.js unstamped.");
    return;
  }

  await writeFile(swPath, stamped);
  console.log(`Stamped sw.js CACHE_VERSION to ${cacheVersion}`);
}

async function compressFile(filePath) {
  const brotliPath = `${filePath}.br`;
  const gzipPath = `${filePath}.gz`;
  await Promise.all([
    pipeline(
      createReadStream(filePath),
      createBrotliCompress({
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
        },
      }),
      createWriteStream(brotliPath),
    ),
    pipeline(createReadStream(filePath), createGzip(), createWriteStream(gzipPath)),
  ]);
}

async function precompressAssets(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  const dirs = entries.filter((entry) => entry.isDirectory());

  for (const file of files) {
    const filePath = path.join(dir, file.name);
    if (COMPRESS_EXTENSIONS.has(path.extname(file.name).toLowerCase())) {
      await compressFile(filePath);
    }
  }

  for (const subdir of dirs) {
    await precompressAssets(path.join(dir, subdir.name));
  }
}

async function measureBundle(dir) {
  let raw = 0;
  let gzip = 0;
  let brotli = 0;

  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      const info = await stat(entryPath);
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === ".br") {
        brotli += info.size;
      } else if (ext === ".gz") {
        gzip += info.size;
      } else {
        raw += info.size;
      }
    }
  }

  await walk(dir);
  return { raw, gzip, brotli };
}

async function main() {
  await exportBrowserWebApp();

  const sourceStat = await stat(SOURCE_DIST).catch(() => null);
  if (!sourceStat?.isDirectory()) {
    throw new Error(`Browser web export not found at ${SOURCE_DIST}`);
  }

  await cleanTarget();
  await copyAssets();
  await stampServiceWorkerCacheVersion();
  await precompressAssets(TARGET_DIST);

  const sizes = await measureBundle(TARGET_DIST);
  console.log("\nStandalone web UI bundle:");
  console.log(`  raw:    ${fmtMiB(sizes.raw)}`);
  console.log(`  gzip:   ${fmtMiB(sizes.gzip)}`);
  console.log(`  brotli: ${fmtMiB(sizes.brotli)}`);
  console.log(`\nOutput: ${path.relative(REPO_ROOT, TARGET_DIST)}/`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
