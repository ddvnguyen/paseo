/**
 * The real-list project / default project coupling, asserted.
 *
 * `vitest.config.ts` runs the real react-native-web VirtualizedList in its own
 * project and excludes those specs from the default one, which aliases
 * `react-native` to the real RN package. Both sides used to be one filename
 * literal, which put the invariant "the real-list project holds exactly the
 * specs that do not mock react-native" into a string nothing checked: delete or
 * rename the spec and the suite went red with "no test files", pointing nowhere
 * near what was lost.
 *
 * Both sides are now the same glob. This test is what gives that coupling
 * teeth — it fails if they drift, if the pattern stops being a glob, if the
 * real-list project goes vacuous, or if a file claims the convention without
 * honouring it.
 *
 * It runs in the DEFAULT project on purpose: it is a .ts test and must never
 * match the real-list pattern, or it would assert the config from inside the
 * project it is policing.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultProject, realListProject, realListPattern } from "../vitest.projects.js";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "..");

interface ProjectShape {
  test: { name: string; include?: string[]; exclude?: string[] };
}
const projects: ProjectShape[] = [defaultProject, realListProject];

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

const relativeTo = (file: string): string => file.replace(`${pluginRoot}/`, "");

/** The trailing segment a recursive glob matches on. */
const suffixOf = (pattern: string): string => pattern.replace("**/", "");

const allSpecs = filesUnder(pluginRoot).filter(
  (file) => file.endsWith(".test.ts") || file.endsWith(".test.tsx"),
);
const realListSpecs = allSpecs.filter((file) => file.endsWith(".window.test.tsx"));

describe("real-list project invariant", () => {
  it("both projects are configured and named", () => {
    expect(projects.map((project) => project.test.name)).toEqual(["default", "real-list"]);
  });

  it("the config wires exactly these two shapes", () => {
    // The invariant must police what the config actually runs, not a parallel
    // copy of it. The config cannot be imported (see its header), so this reads
    // its source and checks it delegates to these two shapes and nothing else.
    const source = readFileSync(resolve(pluginRoot, "vitest.config.ts"), "utf8");
    expect({
      importsProjects: source.includes('from "./vitest.projects.js"'),
      wrapsDefault: source.includes("defineProject(defaultProject)"),
      wrapsRealList: source.includes("defineProject(realListProject)"),
    }).toEqual({ importsProjects: true, wrapsDefault: true, wrapsRealList: true });
  });

  it("the default project excludes exactly what the real-list project includes", () => {
    // The whole point: one predicate, not two spellings of an idea.
    expect(defaultProject.test.exclude).toEqual(realListProject.test.include);
  });

  it("that shared predicate is a glob, not a filename", () => {
    // A literal would put the invariant back in a string. The glob is what lets
    // a conforming rename stay in both projects with no edit.
    expect(realListPattern).toBe("client/**/*.window.test.tsx");
    expect(realListPattern.includes("*")).toBe(true);
  });

  it("the real-list project is not vacuous", () => {
    // The failure this replaces: real-list collects nothing and vitest says
    // "no test files" without saying the plugin lost its only real-list coverage.
    expect({
      matched: realListSpecs.length,
      names: realListSpecs.map(relativeTo),
    }).toEqual({ matched: 1, names: ["client/ledger-screen.window.test.tsx"] });
  });

  it("a spec only qualifies by NOT mocking react-native", () => {
    // Closes the hole the name alone leaves open: a file called *.window.test.tsx
    // that still mocks react-native is not a real-list spec, and running it
    // under react-native-web would be testing the stand-in and calling it the
    // real list.
    const offenders = realListSpecs.filter((file) =>
      /vi\.mock\(\s*["']react-native["']/.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map(relativeTo)).toEqual([]);
  });

  it("no spec is collected by both projects", () => {
    const defaultSuffixes = new Set((defaultProject.test.include ?? []).map(suffixOf));
    const alsoInDefault = realListSpecs
      .map(relativeTo)
      .filter((relative) => defaultSuffixes.has(suffixOf(relative)));
    expect(alsoInDefault).toEqual([]);
  });
});
