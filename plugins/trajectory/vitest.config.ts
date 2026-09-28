import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// `vitest/config` cannot resolve from plugins/ (not a workspace member), so
// import it through the @getpaseo/plugin workspace package, which links the
// same vitest 4.1.10 the repo tests run on.
import {
  defineConfig,
  defineProject,
} from "../../packages/plugin/node_modules/vitest/dist/config.js";

/**
 * Minimal local vitest config. plugins/ is not a pnpm workspace member, so
 * bare imports like `zod` do not resolve from this directory; alias it to the
 * plugin package's install (zod 4.4.3, matching this plugin's override).
 */
const here = dirname(fileURLToPath(import.meta.url));
const pluginPkg = resolve(here, "..", "..", "packages", "plugin");
const appPkg = resolve(here, "..", "..", "packages", "app");

/** The one file that must run against the REAL list, not a stand-in. */
const realListTest = "client/ledger-screen.window.test.tsx";

const sharedAlias = [
  { find: "zod", replacement: resolve(pluginPkg, "node_modules", "zod") },
  // JSX runtime + react must resolve to the SAME react instance the
  // component modules import; plugins/ has no local react install.
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
  // Plugin host contracts (useRpc/usePaseo) resolve to the built
  // workspace package. Test files vi.mock this module with a factory,
  // but vite still needs the path to resolve for import analysis.
  { find: "@getpaseo/plugin/client", replacement: resolve(pluginPkg, "dist", "client") },
];

export default defineConfig({
  test: {
    projects: [
      /**
       * Everything that mocks react-native wholesale. These six files replace
       * FlatList with a `data.map` stand-in, so they cannot see a window.
       */
      defineProject({
        resolve: {
          // Array form: string finds match exactly and by subpath; the plugin
          // client maps to the built dist dir so both the entry and subpaths
          // (client/ui, client/react-native) resolve.
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
          exclude: [realListTest],
        },
      }),

      /**
       * The one project that runs the REAL list.
       *
       * `react-native` here is react-native-web, whose vendored VirtualizedList
       * is the component the host actually renders in a browser. It has never
       * run in this plugin: every other test mocks react-native wholesale, and
       * a second `resolve.alias` on the default project would apply globally
       * and break those six mocks — hence a separate project, not a second
       * alias.
       */
      defineProject({
        resolve: {
          alias: [
            ...sharedAlias,
            {
              find: "react-native",
              replacement: resolve(appPkg, "node_modules", "react-native-web"),
            },
          ],
        },
        test: {
          name: "real-list",
          environment: "jsdom",
          include: [realListTest],
        },
      }),
    ],
  },
});
