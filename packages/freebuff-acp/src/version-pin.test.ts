import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(new URL(import.meta.url).pathname);

const packageJsonPath = path.join(testDir, "..", "package.json");
const catalogPath = path.join(testDir, "..", "..", "app", "src", "data", "acp-provider-catalog.ts");
const docsPath = path.join(testDir, "..", "..", "..", "docs", "custom-providers.md");

const packageVersion = (JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version: string })
  .version;

const PIN_PATTERN = /@getpaseo\/freebuff-acp@([^\s"'`]+)/g;

function extractPinnedVersions(filePath: string): string[] {
  const contents = fs.readFileSync(filePath, "utf8");
  const versions: string[] = [];
  for (const match of contents.matchAll(PIN_PATTERN)) {
    versions.push(match[1]);
  }
  return versions;
}

describe("freebuff-acp version pin consistency", () => {
  it("pins @getpaseo/freebuff-acp@<version> in the catalog to the package version", () => {
    const found = extractPinnedVersions(catalogPath);
    expect(
      found.length,
      `${catalogPath}: expected at least one @getpaseo/freebuff-acp@<pin> occurrence, found ${found.length}`,
    ).toBeGreaterThanOrEqual(1);
    for (const version of found) {
      expect(
        version,
        `${catalogPath}: pinned version "${version}" does not match package.json version "${packageVersion}"`,
      ).toBe(packageVersion);
    }
  });

  it("pins @getpaseo/freebuff-acp@<version> in docs to the package version", () => {
    const found = extractPinnedVersions(docsPath);
    expect(
      found.length,
      `${docsPath}: expected at least one @getpaseo/freebuff-acp@<pin> occurrence, found ${found.length}`,
    ).toBeGreaterThanOrEqual(1);
    for (const version of found) {
      expect(
        version,
        `${docsPath}: pinned version "${version}" does not match package.json version "${packageVersion}"`,
      ).toBe(packageVersion);
    }
  });
});
