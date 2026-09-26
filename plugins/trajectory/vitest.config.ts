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

export default defineConfig({
  resolve: {
    alias: {
      zod: resolve(pluginPkg, "node_modules", "zod"),
    },
  },
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "shared/**/*.test.ts"],
  },
});
