import { describe, expect, it } from "vitest";

import { generateFingerprintId, getCredentialsPath, resolveCredentials } from "./auth.js";

describe("getCredentialsPath", () => {
  it("defaults to ~/.config/manicode/credentials.json", () => {
    expect(getCredentialsPath({})).toMatch(/[/\\]\.config[/\\]manicode[/\\]credentials\.json$/);
  });

  it("honors FREEBUFF_CONFIG_DIR when absolute", () => {
    expect(getCredentialsPath({ FREEBUFF_CONFIG_DIR: "/tmp/fb" })).toBe("/tmp/fb/credentials.json");
  });

  it("returns null for relative FREEBUFF_CONFIG_DIR", () => {
    expect(getCredentialsPath({ FREEBUFF_CONFIG_DIR: "rel/path" })).toBeNull();
  });
});

describe("resolveCredentials", () => {
  it("prefers FREEBUFF_API_KEY from env", () => {
    const resolved = resolveCredentials({ FREEBUFF_API_KEY: " key-1 " }, () => {
      throw new Error("should not read file when env key is set");
    });
    expect(resolved).toEqual({ apiKey: "key-1", source: "env" });
  });

  it("falls back to CODEBUFF_API_KEY", () => {
    const resolved = resolveCredentials({ CODEBUFF_API_KEY: "key-2" }, () => null);
    expect(resolved).toEqual({ apiKey: "key-2", source: "env" });
  });

  it("reads authToken from the CLI credentials file", () => {
    const resolved = resolveCredentials({}, () => ({
      default: { authToken: "tok-3", fingerprintId: "fp-1" },
    }));
    expect(resolved).toEqual({
      apiKey: "tok-3",
      fingerprintId: "fp-1",
      source: "credentials-file",
    });
  });

  it("returns null when nothing is available", () => {
    expect(resolveCredentials({}, () => null)).toBeNull();
    expect(resolveCredentials({}, () => ({ default: { authToken: "" } }))).toBeNull();
  });

  it("returns null when the credentials file is malformed", () => {
    expect(resolveCredentials({}, () => null)).toBeNull();
  });
});

describe("generateFingerprintId", () => {
  it("returns a 64-char hex id", () => {
    const id = generateFingerprintId();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toBe(generateFingerprintId());
  });
});
