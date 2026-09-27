#!/usr/bin/env bash
# Patch installed runtime deps that the repo fixes with patches/ (source installs only;
# deploy installs come from deploy/paseo-*/package.json and never see patches/).
# Usage: patch-runtime-deps.sh <ENV_HOME>
#
# @opencode-ai/sdk: reader.cancel() is fired without a .catch. When the OpenCode event
# stream is closed on abort, cancel() rejects with the abort reason and Bun treats it
# as an unhandled rejection, which kills the daemon (PROD crash loop 2026-09-27).
# Mirrors patches/@opencode-ai+sdk+1.18.23.patch. Idempotent; fails if a file matches
# neither the unpatched nor the patched form, so an SDK bump cannot silently skip it.
set -euo pipefail

home="${1:?usage: patch-runtime-deps.sh <ENV_HOME>}"
patched=0
for sdk in "$home"/node_modules/.pnpm/@opencode-ai+sdk@*/node_modules/@opencode-ai/sdk; do
  [ -d "$sdk" ] || continue
  for rel in dist/gen/core/serverSentEvents.gen.js dist/v2/gen/core/serverSentEvents.gen.js; do
    file="$sdk/$rel"
    [ -f "$file" ] || continue
    if grep -q 'reader\.cancel()\.catch(' "$file"; then
      continue
    fi
    grep -q 'reader\.cancel();' "$file" || { echo "patch-runtime-deps: unrecognised reader.cancel in $file" >&2; exit 1; }
    # sed -i writes a new inode, so the hard-linked pnpm store copy stays untouched.
    sed -i 's/reader\.cancel();/reader.cancel().catch(() => {});/' "$file"
    grep -q 'reader\.cancel()\.catch(' "$file" || { echo "patch-runtime-deps: patch failed for $file" >&2; exit 1; }
    patched=$((patched + 1))
    echo "patch-runtime-deps: patched $file"
  done
done
echo "patch-runtime-deps: $patched file(s) patched in $home"
