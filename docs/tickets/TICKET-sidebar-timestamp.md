# Sidebar trailing timestamp shows statusEnteredAt instead of lastActivityAt

**Status:** Open
**Priority:** Medium
**Labels:** bug, app, sidebar

## Description

The sidebar workspace trailing timestamp shows `statusEnteredAt` (when the workspace entered its current status), not `lastActivityAt` (when the workspace last had activity). For "done" workspaces — the majority — `statusEnteredAt` is `null`, so the timestamp doesn't render at all.

## Root cause

In `packages/app/src/components/sidebar/workspace-trailing/index.tsx`:

```tsx
if (trailing === "timestamp" && workspace.statusEnteredAt) {
  return <WorkspaceTimestamp enteredAt={workspace.statusEnteredAt} />;
}
```

Uses `statusEnteredAt` which is null for done workspaces.

The `SidebarWorkspaceEntry` type (in `hooks/sidebar-workspaces-view-model.ts:58`) has `lastActivityAt?: Date | null` available but it's never used for display.

## Expected behavior

Show `lastActivityAt` (e.g., "5m ago", "2h ago") for all workspaces, regardless of status.

## Possible fix

Change the trailing timestamp to use `workspace.lastActivityAt` instead of `workspace.statusEnteredAt`. The `formatTimeAgo` utility from `utils/time.ts` is already used by the agent list for the same purpose.
