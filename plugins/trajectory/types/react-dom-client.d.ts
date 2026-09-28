/**
 * Local type shim for `react-dom/client`.
 *
 * The repo declares no `@types/react-dom` and `react-dom` ships none, so this
 * module has no declarations anywhere — the app's own component tests carry the
 * same TS2307. Plugin component tests render through `createRoot`, so declare
 * the two symbols they use.
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
