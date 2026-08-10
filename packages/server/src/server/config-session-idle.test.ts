import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "./config.js";

const roots: string[] = [];

async function createPaseoHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-config-session-idle-"));
  roots.push(root);
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  await writeFile(path.join(paseoHome, "config.json"), JSON.stringify(config, null, 2));
  return paseoHome;
}

describe("daemon session idle timeout config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("defaults to 30 minutes when config is absent", async () => {
    const home = await createPaseoHome({ version: 1 });

    expect(loadConfig(home, { env: {} }).sessionIdleTimeoutMs).toBe(30 * 60_000);
  });

  test("loads sessionIdleTimeoutMs from persisted daemon config", async () => {
    const home = await createPaseoHome({
      version: 1,
      daemon: { sessionIdleTimeoutMs: 5 * 60_000 },
    });

    expect(loadConfig(home, { env: {} }).sessionIdleTimeoutMs).toBe(5 * 60_000);
  });

  test("env override wins and zero disables reaping", async () => {
    const home = await createPaseoHome({
      version: 1,
      daemon: { sessionIdleTimeoutMs: 5 * 60_000 },
    });

    expect(
      loadConfig(home, { env: { PASEO_SESSION_IDLE_TIMEOUT_MS: "120000" } }).sessionIdleTimeoutMs,
    ).toBe(120_000);
    expect(
      loadConfig(home, { env: { PASEO_SESSION_IDLE_TIMEOUT_MS: "0" } }).sessionIdleTimeoutMs,
    ).toBe(0);
  });
});
