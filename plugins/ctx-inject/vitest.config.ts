import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// `vitest/config` cannot resolve from plugins/ (not a workspace member), so
// import it through the @getpaseo/plugin workspace package, which links the
// same vitest 4.1.10 the repo tests run on.
import { defineConfig } from "../../packages/plugin/node_modules/vitest/dist/config.js";

/**
 * Minimal local vitest config. plugins/ is not a pnpm workspace member, so
 * bare imports like `zod` do not resolve from this directory; alias it to the
 * plugin package's install (zod 4.4.3, matching this plugin's override).
 */
const here = dirname(fileURLToPath(import.meta.url));
const pluginPkg = resolve(here, "..", "..", "packages", "plugin");
const appPkg = resolve(here, "..", "..", "packages", "app");

export default defineConfig({
  resolve: {
    // Array form: string finds match exactly and by subpath; the plugin
    // client maps to the built dist dir so both the entry and subpaths
    // (client/ui, client/react-native) resolve.
    alias: [
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
      // RN resolves from packages/app (same version the host ships).
      { find: "react-native", replacement: resolve(appPkg, "node_modules", "react-native") },
      // Plugin host contracts (useRpc/usePaseo) resolve to the built
      // workspace package. Test files vi.mock this module with a factory,
      // but vite still needs the path to resolve for import analysis.
      { find: "@getpaseo/plugin/client", replacement: resolve(pluginPkg, "dist", "client") },
    ],
  },
  test: {
    environment: "node",
    // Component tests opt into jsdom per file (`@vitest-environment jsdom`
    // pragma, the repo-wide pattern); jsdom resolves from packages/app.
    include: ["server/**/*.test.ts", "shared/**/*.test.ts", "client/**/*.test.tsx"],
  },
});
