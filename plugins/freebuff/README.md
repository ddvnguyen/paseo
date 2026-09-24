# Freebuff plugin for Paseo

Runs the `freebuff-acp` adapter (`packages/freebuff-acp`) as a Paseo provider and adds a
**Freebuff** sidebar page with per-account quota and a model-catalog check.

## Install

```bash
paseo plugin add ddvnguyen/paseo:plugins/freebuff   # git source: owner/repo:subpath
paseo plugin reload freebuff
```

The build step (`paseo-plugin.json`) runs `npm install --omit=dev` and `scripts/build.mjs`, which
compiles the adapter into `dist/`, patches `@codebuff/sdk` (metadata hook the adapter needs), and
writes `server/generated.ts` with the absolute adapter path. Requires plugins to be enabled
(`pluginsEnabled`), and Freebuff credentials (`freebuff login`) for the daemon user.

## Multiple accounts

Each extra account is a Freebuff config dir logged in with `FREEBUFF_CONFIG_DIR`:

```bash
FREEBUFF_CONFIG_DIR=$HOME/.config/manicode-work freebuff login
node dist/cli.js accounts add work $HOME/.config/manicode-work "Work"
node dist/cli.js status          # quota per account + model check (JSON, no tokens)
```

`accounts.json` (`~/.config/freebuff-acp/`, override `FREEBUFF_ACP_ACCOUNTS_FILE`) stores paths only.
In a session, the **Account** setting lists every account with its remaining Freebucks; switching
keeps the conversation. `FREEBUFF_ACCOUNT=<id>` sets the account new sessions start on.

## Pinned dependencies

`zod` is pinned to 4.4.3 and `ai` to 5.0.78: `@codebuff/sdk@0.10.7` fails at run time
(`Cannot read properties of undefined (reading 'parent')`) with zod ≥ 4.6. Re-verify with the real
e2e (`packages/freebuff-acp/scripts/acp-e2e.ts`) before bumping.

## Differences from the built-in Freebuff provider

The plugin ACP shim has no `paseo/questions` rich `ask_user`; questions fall back to single-choice.
Provider id is `freebuff`: remove any `providers.freebuff` entry from `config.json` first.
