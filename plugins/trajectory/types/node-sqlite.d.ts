/**
 * Local type shim for `node:sqlite`.
 *
 * `server/node-store.ts` uses Node's builtin SQLite, but the `@types/node` this
 * plugin resolves (20.x) predates the module — `node:sqlite` landed in Node
 * 22.5. Rather than bump a shared dependency for one plugin, declare the surface
 * the store actually calls.
 *
 * DELETE THIS FILE once the plugin resolves `@types/node` >= 22, which carries
 * the real declarations; a hand-written stand-in would then be a second,
 * conflicting source of truth for the same module.
 */
declare module "node:sqlite" {
  export interface StatementSync {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    iterate(...params: unknown[]): IterableIterator<unknown>;
  }

  export interface DatabaseSyncOptions {
    open?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
    readOnly?: boolean;
  }

  export class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
