# Runtime and package manager

Paseo resolves with pnpm and executes with bun 1.4.2. Two tools, one job each.

- **pnpm owns resolution.** It reads `pnpm-lock.yaml` and produces `node_modules`.
- **bun owns execution.** Every process that runs daemon code is a bun process.

Keep that split when you touch either side. A pnpm change belongs to the resolver; a
runtime change belongs to the executor. Moving work across the line is what turns a
dependency bump into a production incident.

## Where the pin lives

`.tool-versions` holds `bun 1.4.2`. That is the repo's existing multi-tool version
file and already pins rust, nodejs, java and android-sdk; mise and asdf both read it.

`packageManager` in `package.json` stays `pnpm@11.12.0`. That field is corepack's
package-manager slot and can only ever name one manager, so putting bun there would
break `pnpm install`. One concern per file: `.tool-versions` says what runs,
`packageManager` says what installs.

The version appears in exactly two places, and `scripts/runtime-pin.test.mjs` fails
CI if they disagree:

| Where                                      | Why it is a copy                                      |
| ------------------------------------------ | ----------------------------------------------------- |
| `.tool-versions`                           | The pin.                                              |
| `.github/workflows/ci.yml` (`bun-version`) | `oven-sh/setup-bun` takes a literal, not a file path. |

`.nvmrc` and the `nodejs` entry stay. Node still runs Expo and Metro, and the CI jobs
that build the app. Removing it is a separate decision.

## A pin nothing reads is a label

Before this policy the repo shipped `paseo-bun` wrappers that hardcoded
`$HOME/.bun/bin/bun` and asserted nothing, with a comment reading "bun 1.4.x".
Whatever sat at that path ran.

`scripts/bun-runtime.sh` is the enforcement point. It reads the version back out of
`.tool-versions`, resolves a bun through mise, then asdf, then `PATH`, then
`~/.bun/bin/bun`, and compares exactly. Every runtime entry point calls it:

| Entry point                     | How it enforces                                                             |
| ------------------------------- | --------------------------------------------------------------------------- |
| `scripts/dev-daemon.sh`         | sources the helper, then prepends the asserted binary's directory to `PATH` |
| `~/paseo/{PROD,TEST}/paseo-bun` | version substituted in at generation time, asserted in the generated file   |
| `deploy/fleet-backend.service`  | `ExecStartPre` assertion; this unit has no launcher script                  |
| `scripts/verify-bun-runtime.sh` | asserts, then boots the daemon and proves the runtime                       |

**No entry point falls back to node.** A silent fallback is the specific failure this
policy exists to prevent: the daemon boots on an unpinned runtime, the repo still
claims 1.4.2, and nothing reports an error.

`dev-daemon.sh` puts the asserted binary first on `PATH` for a reason. The package
scripts call `bun` by name, so without that they could resolve a different binary and
the assertion would be decorative.

## Runtime paths

The daemon process chain never names a runtime. Each link uses `process.execPath` or
`child_process.fork`, so the whole chain inherits whatever runtime started it:

```
paseo-bun  ->  bun cli/dist/index.js          (packages/cli/.../local-daemon.ts:57)
            ->  bun supervisor-entrypoint.js
            ->  bun daemon-worker.js           (packages/server/scripts/supervisor.ts:260)
            ->  bun terminal-worker-process.js (child_process.fork)
```

Pinning the top of that chain pins all of it. The reason to know this: a hardcoded
`node` anywhere in the chain would be the only thing that could break the
inheritance, and `runtime-pin.test.mjs` asserts there is none.

Converted:

| Path                       | File                                                  |
| -------------------------- | ----------------------------------------------------- |
| PROD systemd unit          | `deploy/systemd/paseo.service` (via `paseo-bun`)      |
| TEST systemd unit          | `deploy/systemd/paseo-test.service` (via `paseo-bun`) |
| Runtime launcher generator | `deploy/consolidate-paseo-home.sh`                    |
| fleet-backend unit         | `deploy/fleet-backend.service`                        |
| Dev daemon                 | `scripts/dev-daemon.sh`, `packages/server` `dev`      |
| Dev CLI                    | `package.json` `cli`                                  |
| Dev config writer          | `scripts/dev-home.sh`                                 |
| Packaged server entry      | `packages/server` `start`                             |

Deliberately not converted, each with a reason:

| Path                                          | Runs on           | Why                                                                                            |
| --------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| `postinstall` and install-time scripts        | node              | pnpm runs lifecycle scripts with its own node. Making install depend on bun inverts the split. |
| `build:*`                                     | node              | Build-time. Runs before a runtime is needed.                                                   |
| `version:*`, `release:*`, `fdroid:*`, `acp:*` | node              | Release one-shots, not runtime.                                                                |
| Expo / Metro (`dev-app.sh`, `start:expo`)     | node              | Separate toolchain with its own node requirement.                                              |
| `packages/desktop` packaged daemon            | Electron's binary | See below.                                                                                     |
| `packages/server` `dev:tsx`                   | tsx (node)        | Unreferenced, and kept as the escape hatch for bisecting a bun-only problem.                   |
| CI test suites                                | node              | vitest executes them. The daemon itself is proven on bun separately.                           |

`packages/desktop` is the interesting one. `resolveNodeExecPath()` returns
`process.execPath`, which inside a packaged Electron app is the Electron binary, not
a system node and not bun. That is deliberate: the desktop app ships its runtime
inside Electron and reaches it through `ELECTRON_RUN_AS_NODE=1` and
`node-entrypoint-runner.js`. Moving the packaged desktop daemon to bun means
shipping a bun binary inside the app bundle. That is a packaging decision, not a
find-and-replace.

`npm run` and `cross-env` are themselves node processes, so every dev launch passes
through node before reaching bun. The daemon is bun; the script runner around it is
not.

## Cross-manager gaps

These are the places where pnpm resolving and bun executing do not line up. Each one
is a real limitation, not a TODO.

**The frozen lockfile does not describe bun's view of the tree.**
`pnpm install --frozen-lockfile` guarantees pnpm's resolution and pnpm's
`node_modules` layout. bun resolves through Node's algorithm against that same
directory. Anything that resolves differently under the two — an exports-map
condition, a peer-dependency edge, a `bin` shim — is invisible to the lockfile. A
green `--frozen-lockfile` is not evidence that bun will load what you expect.

**`bun.lock` is in the repo and is not the authority.**
A 6854-line `bun.lock` is tracked at the root, left over from when bun owned
installs. `pnpm-lock.yaml` is what actually resolves. Two lockfiles, one authority,
and tooling already has to work around the wrong one:
`.github/workflows/android-apk-release.yml:112` deletes `bun.lock` and `bun.lockb`
specifically so EAS does not detect a bun workspace and run `bun install`. Until that
file is removed or regenerated deliberately, treat any tool that keys off
`bun.lock` as a hazard.

**Install-time scripts never see the pinned bun.**
`postinstall` runs under pnpm's node. Patches applied by `patch-package` are applied
by node semantics, and the runtime that later loads those files is bun.

**Dev-mode V8 flags are accepted and ignored.**
`resolveWorkerExecArgv` attaches `--max-old-space-size=3072`,
`--heapsnapshot-near-heap-limit=3`, `--report-on-fatalerror` and
`--report-directory`. bun 1.4.2 accepts all of them without error and honours none of
them. The worker does start, but the heap ceiling is not enforced and no fatal-error
report is written. Do not read a clean dev run as evidence the memory limits held.

**`--import tsx` is redundant under bun.**
bun transpiles TypeScript natively. The flag still loads tsx (verified: it resolves to
`tsx@4.21.0/dist/loader.mjs`), so keeping it is harmless, but it is not what makes the
dev daemon able to read `.ts`.

**`@server/*` would not resolve under bun.**
`packages/server/tsconfig.server.json` declares `paths: {"@server/*": ["./src/*"]}`,
and there is no plain `tsconfig.json` in that package for bun to read. Only three test
files use the alias, so no runtime path is affected today. A new non-test file using
`@server/*` will fail under bun in a way that passes under node.

**Native addons are only as good as their last test run.**
fleet-backend depends on `@tursodatabase/database`, a Rust NAPI addon, and takes an
exclusive lock on `fleet.db`. A runtime that loaded the addon differently would fail
at `open`, not at query. It was verified working under bun 1.4.2
(`packages/fleet-backend` `config-api-storage` tests, which open a real database), but
an addon upgrade can change that, and `packages/fleet-backend/tests` on node is the
only automated guard.

## Checking it

```bash
scripts/verify-bun-runtime.sh          # boot the daemon on the pinned bun and drain it
scripts/verify-bun-runtime.sh 6767     # refuses; PROD is 6767, TEST is 6868
node --test scripts/runtime-pin.test.mjs
```

`verify-bun-runtime.sh` exists because the daemon tests cannot prove this. They spawn
the daemon through `process.execPath`, so they run on whatever executes vitest. Under
node they stay green while production is broken on bun.

It reads `/proc/<pid>/exe` for every process in the chain rather than trusting the
command line, and requires the tree to drain, the port to free and the PID lock to
disappear. It exports `PASEO_HOME` on purpose: an unexported `PASEO_HOME` lets the
daemon inherit the caller's, which on a dev box is the live `~/.paseo`.
