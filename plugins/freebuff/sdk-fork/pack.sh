#!/usr/bin/env bash
# Rebuild vendor/codebuff-sdk-*.tgz from the ddvnguyen/freebuff fork (a git
# submodule of LLM-Agents-Orchestration at external/freebuff).
#
#   sdk-fork/pack.sh /path/to/freebuff-fork <version>
#
# The fork's build inlines NEXT_PUBLIC_* values; build.env carries the public
# values shipped in the npm @codebuff/sdk dist. Requires bun + npm.
set -euo pipefail
FORK="${1:?path to freebuff fork checkout}"
VERSION="${2:?version, e.g. 0.10.7-paseo.1}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../vendor"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

(cd "$FORK" && bun install --frozen-lockfile)
# The build's declaration-bundling step may report upstream type errors; the
# ESM/CJS bundles are still emitted, so judge success by the artifacts.
(cd "$FORK/sdk" && rm -rf dist && set -a && . "$HERE/build.env" && set +a && bun run build || true)
[ -f "$FORK/sdk/dist/index.mjs" ] && [ -f "$FORK/sdk/dist/index.cjs" ] || { echo "SDK build produced no bundles" >&2; exit 1; }
grep -q extraCodebuffMetadata "$FORK/sdk/dist/index.mjs" || { echo "fork SDK lacks extraCodebuffMetadata" >&2; exit 1; }

cp -r "$FORK/sdk/dist" "$FORK/sdk/package.json" "$FORK/sdk/README.md" "$FORK/sdk/CHANGELOG.md" "$STAGE/"
find "$STAGE/dist" -name '*.map' -delete
python3 - "$STAGE/package.json" "$VERSION" <<'PY'
import json, sys
path, version = sys.argv[1:3]
p = json.load(open(path))
p.update(name="@codebuff/sdk", version=version)
for key in ("scripts", "devDependencies", "types"):
    p.pop(key, None)
p["exports"] = {".": {"import": "./dist/index.mjs", "require": "./dist/index.cjs"}, "./package.json": "./package.json"}
json.dump(p, open(path, "w"), indent=2)
PY
mkdir -p "$OUT"
(cd "$STAGE" && npm pack --ignore-scripts --pack-destination "$OUT" >/dev/null)
echo "wrote $OUT/codebuff-sdk-$VERSION.tgz — update plugins/freebuff/package.json and the lockfile"
