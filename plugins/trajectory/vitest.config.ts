import {
  defineConfig,
  defineProject,
} from "../../packages/plugin/node_modules/vitest/dist/config.js";
// `vitest/config` cannot resolve from plugins/ (not a workspace member), so it
// is imported through the @getpaseo/plugin workspace package, which links the
// same vitest 4.1.10 the repo tests run on.
//
// The project shapes live in vitest.projects.ts rather than inline here,
// because a test needs to assert the real-list / default coupling and cannot
// import THIS file: TypeScript typechecks an imported config as an ordinary
// module, and defineProject's overloads then reject the project-level
// `resolve` block. Keeping the data in a plain module lets the invariant be
// asserted while the real typecheck stays here, where defineProject validates
// the shapes.
import { defaultProject, realListProject } from "./vitest.projects.js";

/**
 * Minimal local vitest config. plugins/ is not a pnpm workspace member, so
 * bare imports like `zod` do not resolve from this directory; vitest.projects.ts
 * aliases them to the plugin package's install (zod 4.4.3, matching this
 * plugin's override).
 */
export default defineConfig({
  test: {
    projects: [defineProject(defaultProject), defineProject(realListProject)],
  },
});
