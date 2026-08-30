# Sidebar timestamp press-to-toggle duration not implemented

**Status:** Open
**Priority:** Low
**Labels:** enhancement, app, sidebar

## Description

Users expect to press the sidebar timestamp to toggle between "last activity time" (e.g., "5m ago") and "duration" (e.g., "12m 30s"). Currently the timestamp is a plain `<Text>` with no press handler.

## Current state

- `workspace-trailing/index.tsx`: `WorkspaceTimestamp` renders a plain `<Text>` — no `Pressable` wrapper.
- `SidebarWorkspaceTrailing` type: `"diff" | "timestamp" | "none"` — no "duration" option.
- `formatDuration` exists in `utils/time.ts:153` and `AggregatedAgent` has both `createdAt` and `lastActivityAt` fields, but neither is used for sidebar duration display.

## Expected behavior

Tapping the timestamp toggles between:

- Relative time: "5m ago", "2h ago"
- Duration: "12m 30s", "1h 45m"

## Possible implementation

1. Add a `"duration"` option to `SidebarWorkspaceTrailing` type.
2. Add local state or a setting to toggle between "timestamp" and "duration".
3. Wrap `WorkspaceTimestamp` in a `Pressable`.
4. Compute duration from `createdAt` to `lastActivityAt` using `formatDuration` from `utils/time.ts`.
