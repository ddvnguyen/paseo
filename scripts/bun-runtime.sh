#!/usr/bin/env bash
# bun-runtime.sh — the single enforcement point for the bun runtime pin.
#
# WHY THIS EXISTS
#   `.tool-versions` declares `bun 1.4.2`. Nothing read it: the systemd launchers
#   and the dev scripts each hardcoded their own idea of "the bun binary", so the
#   repo carried a version *label* while every process actually ran whatever
#   happened to be first on PATH. This file makes the declaration binding.
#
# WHERE THE PIN LIVES
#   `.tool-versions` — the repo's existing multi-tool version file (already pins
#   rust, nodejs, java, android-sdk). `packageManager` in package.json is NOT
#   used: that is corepack's *package manager* pin and must stay `pnpm@11.12.0`.
#   pnpm resolves the dependency graph; bun executes it. One file per concern.
#
# NO FALLBACK
#   If the required bun is missing or the version differs, these helpers exit
#   non-zero with the exact expected/actual pair. They never fall back to node.
#   A silent fallback would make the pin a lie: the daemon would boot on an
#   unpinned runtime while the repo claimed 1.4.2.
#
# Usage:
#   source scripts/bun-runtime.sh
#   paseo_assert_bun            # die unless the required bun is on PATH; sets BUN_BIN
#   BUN="$(paseo_find_bun)"     # print the resolved bun path, or fail
#   paseo_required_bun_version  # print the pinned version, read from .tool-versions

# Absolute path to the bun binary, exported for callers that exec it.
BUN_BIN=""

paseo_repo_root() {
  # shellcheck disable=SC2155
  local candidate
  candidate="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd || true)"
  if [ -z "$candidate" ] || [ ! -f "$candidate/.tool-versions" ]; then
    candidate="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  fi
  printf '%s\n' "$candidate"
}

# Read the pinned bun version out of .tool-versions. Single source of truth.
paseo_required_bun_version() {
  local root
  root="$(paseo_repo_root)"
  local line
  line="$(awk '$1 == "bun" { print $2; exit }' "$root/.tool-versions" 2>/dev/null || true)"
  if [ -z "$line" ]; then
    echo "paseo: no 'bun' entry in $root/.tool-versions — the runtime pin is missing." >&2
    return 1
  fi
  printf '%s\n' "$line"
}

# Print the absolute path of a bun binary, or nothing if none is found.
paseo_find_bun() {
  local candidate
  # 1. A version-manager shim (mise/asdf) already honours .tool-versions.
  if command -v mise >/dev/null 2>&1 && mise which bun >/dev/null 2>&1; then
    mise which bun
    return 0
  fi
  if command -v asdf >/dev/null 2>&1; then
    candidate="$(asdf which bun 2>/dev/null || true)"
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi
  # 2. Whatever `bun` resolves to on PATH.
  candidate="$(command -v bun 2>/dev/null || true)"
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  # 3. The canonical install location, for shells with a thin PATH
  #    (systemd units are the reason this fallback exists).
  if [ -x "$HOME/.bun/bin/bun" ]; then
    printf '%s\n' "$HOME/.bun/bin/bun"
    return 0
  fi
  return 1
}

# Assert the on-disk bun is exactly the pinned version. Exports BUN_BIN.
paseo_assert_bun() {
  local required actual resolved
  if ! required="$(paseo_required_bun_version)"; then
    return 1
  fi
  if ! resolved="$(paseo_find_bun)"; then
    echo "paseo: bun $required is required but no bun binary was found." >&2
    echo "paseo: install it (curl -fsSL https://bun.sh/install | bash -s \"bun-v$required\")" >&2
    echo "paseo: or run 'mise install' / 'asdf install' to honour .tool-versions." >&2
    echo "paseo: refusing to fall back to node — the runtime pin would be unenforced." >&2
    return 1
  fi
  actual="$("$resolved" --version 2>/dev/null | tr -d '[:space:]')"
  if [ "$actual" != "$required" ]; then
    echo "paseo: bun version mismatch." >&2
    echo "paseo:   required: $required   (from .tool-versions)" >&2
    echo "paseo:   actual:   ${actual:-<unknown>}   ($resolved)" >&2
    echo "paseo: refusing to run on an unpinned runtime, and refusing to fall back to node." >&2
    return 1
  fi
  BUN_BIN="$resolved"
  export BUN_BIN
  export PASEO_REQUIRED_BUN_VERSION="$required"
  return 0
}
