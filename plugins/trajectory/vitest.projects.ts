/**
 * The two vitest projects, as PLAIN data.
 *
 * They live outside vitest.config.ts so that window-project-invariant.test.ts
 * can import and compare them. The config cannot be imported from a test:
 * TypeScript then typechecks it as an ordinary module rather than as a config,
 * and defineProject's overloads reject the project-level `resolve` block
 * (`Object literal may only specify known properties, and 'resolve' does not
 * exist in type 'UserProjectConfigExport'`). Keeping the real typecheck where
 * it belongs — inside vitest.config.ts, wrapped in defineProject — and the
 * data here is what lets the invariant be asserted at all.
 *
 * No vitest imports on purpose: this module is data, and the config is what
 * validates it.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginPkg = resolve(here, "..", "..", "packages", "plugin");
const appPkg = resolve(here, "..", "..", "packages", "app");

/**
 * The real-list convention, as ONE glob used for BOTH sides of the coupling.
 *
 * A spec that must run against the real react-native-web VirtualizedList is
 * named `*.window.test.tsx` under client/. The real-list project includes that
 * pattern and the default project excludes the SAME pattern, so the two sides
 * are one predicate and cannot drift.
 *
 * This was a single filename literal before, which put the invariant "the
 * real-list project holds exactly the specs that do not mock react-native"
 * into a string nothing asserted: delete or rename the spec and the suite went
 * red with "no test files", pointing nowhere near what was lost. A conforming
 * rename now stays in both projects with no edit to this file.
 *
 * Vitest globs `include` and `exclude` through the same
 * `globFiles(include, exclude, cwd)` (globTestFiles -> globAllTestFiles ->
 * globFiles), so the pattern needs no separate form for exclude.
 */
export const realListPattern = "client/**/*.window.test.tsx";

/** Aliases both projects share; only the react-native target differs. */
export const sharedAlias = [
  { find: "zod", replacement: resolve(pluginPkg, "node_modules", "zod") },
  // JSX runtime + react must resolve to the SAME react instance the component
  // modules import; plugins/ has no local react install.
  {
    find: "react/jsx-dev-runtime",
    replacement: resolve(pluginPkg, "node_modules", "react", "jsx-dev-runtime.js"),
  },
  {
    find: "react/jsx-runtime",
    replacement: resolve(pluginPkg, "node_modules", "react", "jsx-runtime.js"),
  },
  { find: "react", replacement: resolve(pluginPkg, "node_modules", "react") },
  // Test-only renderer (jsdom stand-in for RN); never imported by plugin code.
  {
    find: "react-dom/client",
    replacement: resolve(appPkg, "node_modules", "react-dom", "client.js"),
  },
  { find: "react-dom", replacement: resolve(appPkg, "node_modules", "react-dom") },
  // Plugin host contracts (useRpc/usePaseo) resolve to the built workspace
  // package. Test files vi.mock this module with a factory, but vite still
  // needs the path to resolve for import analysis.
  { find: "@getpaseo/plugin/client", replacement: resolve(pluginPkg, "dist", "client") },
];

/**
 * Everything that mocks react-native wholesale. These files replace FlatList
 * with a `data.map` stand-in, so they cannot see a window.
 */
export const defaultProject = {
  resolve: {
    // Array form: string finds match exactly and by subpath; the plugin client
    // maps to the built dist dir so both the entry and subpaths resolve.
    alias: [
      ...sharedAlias,
      // RN resolves from packages/app (same version the host ships).
      { find: "react-native", replacement: resolve(appPkg, "node_modules", "react-native") },
    ],
  },
  test: {
    name: "default",
    environment: "node",
    // Component tests opt into jsdom per file (`@vitest-environment jsdom`
    // pragma, the repo-wide pattern); jsdom resolves from packages/app.
    // `.test.ts` is matched alongside `.test.tsx` so non-JSX client modules
    // (e.g. the header-button registration) cannot silently never run.
    include: [
      "server/**/*.test.ts",
      "shared/**/*.test.ts",
      "client/**/*.test.ts",
      "client/**/*.test.tsx",
    ],
    exclude: [realListPattern],
  },
};

/**
 * The project that runs the REAL list.
 *
 * `react-native` here is react-native-web, whose vendored VirtualizedList is
 * the component the host actually renders in a browser. It has never run in
 * this plugin: every other test mocks react-native wholesale, and a second
 * `resolve.alias` on the default project would apply globally and break those
 * mocks — hence a separate project, not a second alias.
 */
export const realListProject = {
  resolve: {
    alias: [
      ...sharedAlias,
      { find: "react-native", replacement: resolve(appPkg, "node_modules", "react-native-web") },
    ],
  },
  test: {
    name: "real-list",
    environment: "jsdom",
    include: [realListPattern],
  },
};
