/**
 * Local type shim for `react-dom/client`.
 *
 * The repo has no `@types/react-dom` dependency and `react-dom` ships none, so
 * this module has no declarations anywhere — the app's own component tests carry
 * the same TS7016. This plugin's component test renders through `createRoot`, so
 * it declares the two symbols it uses.
 *
 * DELETE THIS FILE once `@types/react-dom` is added to the repo: real
 * declarations take precedence, and a hand-written stand-in would then be a
 * second, conflicting source of truth for the same module.
 */
declare module "react-dom/client" {
  export interface Root {
    render(children: unknown): void;
    unmount(): void;
  }
  export function createRoot(container: unknown): Root;
}
