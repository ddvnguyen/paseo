import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import gte from "semver/functions/gte.js";
import valid from "semver/functions/valid.js";

/**
 * Floor guard for the OpenCode Zen free-tier version gate.
 *
 * Since late Sep 2026 the Zen API answers 426 "OpenCode 1.18.0 or newer is
 * required to use the free tier" to older clients. A gated turn fails before
 * any assistant text, thinking, or tool output streams, which reads in Paseo
 * Web as "streaming is broken". Zen checks the version of the opencode
 * server binary the daemon spawns from PATH (server-manager.ts), so hosts
 * must also run opencode >= 1.18.0 — verify with `opencode --version` on
 * TEST/PROD. The declared SDK stays on the same 1.18 line so the localhost
 * client stays in sync with the server and patches/@opencode-ai+sdk+*.patch
 * applies to the installed version:
 *
 * - every manifest that ships the SDK (workspace + both deploy runtimes)
 *   pins an exact version >= 1.18.0 (no ^ ranges on this dep);
 * - the installed SDK satisfies the same floor (catches lockfile drift
 *   where the manifests say 1.18.x but the install resolved older).
 *
 * Commit 720c24ff4 had to drop the 1.18.23 pin because pnpm-lock.yaml was
 * not refreshed in the same commit and the frozen-lockfile deploy gate
 * failed. If you bump this dep, refresh the root lockfile AND both deploy
 * lockfiles (`pnpm install --lockfile-only` + `--ignore-workspace --dir
 * deploy/paseo-{test,prod}`) or this test's installed-version assertion
 * and the deploy gate will both fail.
 */
const ZEN_MIN_SDK_VERSION = "1.18.0";

const MANIFESTS = [
  "packages/server/package.json",
  "deploy/paseo-test/package.json",
  "deploy/paseo-prod/package.json",
] as const;

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("repo root not found");
    dir = parent;
  }
}

function declaredSdkVersion(manifestRel: string): string {
  const manifestPath = path.join(repoRoot(), manifestRel);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const spec = manifest.dependencies?.["@opencode-ai/sdk"];
  expect(spec, `${manifestRel} must declare @opencode-ai/sdk`).toBeDefined();
  return spec as string;
}

/**
 * SDK root resolved through the exported v2 client entrypoint. CJS
 * require.resolve cannot see this ESM-only package (its exports map has no
 * "require" condition), and ./package.json is not exported either.
 */
function installedSdkVersion(): string {
  const anchor = fileURLToPath(
    (import.meta as unknown as { resolve(s: string): string }).resolve(
      "@opencode-ai/sdk/v2/client",
    ),
  );
  let dir = path.dirname(anchor);
  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const manifest = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (manifest.name === "@opencode-ai/sdk" && manifest.version) return manifest.version;
      } catch {
        // Keep walking up past unreadable manifests.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("could not locate installed @opencode-ai/sdk");
    dir = parent;
  }
}

describe("OpenCode SDK Zen version floor", () => {
  test.each(MANIFESTS)("%s pins @opencode-ai/sdk >= 1.18.0 exactly", (manifestRel) => {
    const spec = declaredSdkVersion(manifestRel);
    expect(valid(spec), `${manifestRel}: expected an exact version, got ${spec}`).not.toBeNull();
    expect(
      gte(spec, ZEN_MIN_SDK_VERSION),
      `${manifestRel}: @opencode-ai/sdk ${spec} is below the Zen floor ${ZEN_MIN_SDK_VERSION}`,
    ).toBe(true);
  });

  test("installed @opencode-ai/sdk satisfies the Zen floor", () => {
    const version = installedSdkVersion();
    expect(valid(version)).not.toBeNull();
    expect(
      gte(version, ZEN_MIN_SDK_VERSION),
      `installed @opencode-ai/sdk ${version} is below the Zen floor ${ZEN_MIN_SDK_VERSION}`,
    ).toBe(true);
  });
});
