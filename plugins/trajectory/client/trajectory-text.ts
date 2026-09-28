import { useCallback, useEffect, useMemo, useRef } from "react";
import type { TrajectoryCellProps } from "../shared/dsh/record.js";

/**
 * On-demand text for ledger rows (C4 item 3e).
 *
 * The recorder is length-only by design: it persists a row's character count
 * and the source item's identity, never the text. This resolves the text for
 * rows the user is actually looking at, and holds it in memory for the session
 * only. Fetched text is never written back to the recorder, never persisted, and
 * never logged — a row that cannot be resolved keeps its `(N chars)` label and
 * that is a normal outcome, never an error state.
 *
 * Keying is by `sourceMessageId` for message rows and `callId` for tool rows,
 * which is what the recorder persisted. A row with neither simply never
 * resolves.
 */

/** Cache key for one record. Kept explicit so the key space is obvious. */
export function textKey(cell: TrajectoryCellProps): string | null {
  if (typeof cell.sourceMessageId === "string" && cell.sourceMessageId.length > 0) {
    return `m:${cell.sourceMessageId}`;
  }
  if (typeof cell.callId === "string" && cell.callId.length > 0) {
    return `c:${cell.callId}`;
  }
  return null;
}

/** Timeline item -> the text a row would show, or null when it carries none. */
function itemText(item: TimelineEntryLike["item"]): string | null {
  if (!item || (item.type !== "user_message" && item.type !== "assistant_message")) return null;
  return typeof item.text === "string" && item.text.length > 0 ? item.text : null;
}

export type TextCache = Map<string, string>;

/** The slice of a timeline fetch entry the resolver reads. */
export interface TimelineEntryLike {
  item?:
    | { type?: string; text?: unknown; messageId?: string; clientMessageId?: string }
    | undefined;
  callId?: string | undefined;
}

export type TimelineRefetch = () => Promise<{ entries?: readonly TimelineEntryLike[] } | null>;

export interface ResolveOptions {
  /** Visible cells only; the caller decides what "visible" means. */
  cells: readonly TrajectoryCellProps[];
  agentId: string;
  /** Fetches the agent's timeline page. Injected so the resolver is testable. */
  refetch: TimelineRefetch;
  /** Session-lifetime cache. */
  cache: TextCache;
}

/**
 * Resolve the text for the given cells, fetching at most once per call and
 * filling the cache. Returns the keys it could not resolve so the caller can
 * distinguish "not yet fetched" from "no key at all".
 */
export async function resolveVisibleText(options: ResolveOptions): Promise<Set<string>> {
  const { cells, cache, refetch } = options;
  const wanted = new Map<string, TrajectoryCellProps>();
  const unresolved = new Set<string>();
  for (const cell of cells) {
    const key = textKey(cell);
    if (key === null) continue;
    if (cache.has(key)) continue;
    wanted.set(key, cell);
  }
  if (wanted.size === 0) return unresolved;

  let entries: { entries?: readonly TimelineEntryLike[] } | null;
  try {
    entries = await refetch();
  } catch {
    // A failed fetch leaves every wanted key unresolved; the row keeps its length.
    for (const key of wanted.keys()) unresolved.add(key);
    return unresolved;
  }

  const byMessageId = new Map<string, string>();
  const byCallId = new Map<string, string>();
  for (const entry of entries?.entries ?? []) {
    const text = itemText(entry.item);
    if (text === null) continue;
    const item = entry.item;
    const messageId = item?.messageId ?? item?.clientMessageId;
    if (typeof messageId === "string") byMessageId.set(messageId, text);
    if (typeof entry.callId === "string") byCallId.set(entry.callId, text);
  }

  for (const [key] of wanted) {
    const value = key.startsWith("m:") ? byMessageId.get(key.slice(2)) : byCallId.get(key.slice(2));
    if (typeof value === "string") cache.set(key, value);
    else unresolved.add(key);
  }
  return unresolved;
}

export interface UseTrajectoryText {
  cache: TextCache;
  /** Text for a cell, or undefined while unresolved / unkeyable. */
  textFor: (cell: TrajectoryCellProps) => string | undefined;
  /** Re-resolve the currently visible cells. */
  refresh: () => void;
}

/**
 * Session-lifetime resolver. `visible` should be the cells actually on screen;
 * the effect only refetches when that set changes, so scrolling an unkeyed
 * transcript does not generate traffic.
 */
export function useTrajectoryText(
  agentId: string,
  visible: readonly TrajectoryCellProps[],
  refetch: TimelineRefetch,
): UseTrajectoryText {
  const cacheRef = useRef<TextCache | null>(null);
  if (cacheRef.current === null) cacheRef.current = new Map();
  const cache = cacheRef.current;
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  // Key the effect on the SET of keys, not the array identity: the FlatList hands
  // a new array on every render.
  const keys = useMemo(() => {
    const set = new Set<string>();
    for (const cell of visible) {
      const key = textKey(cell);
      if (key !== null) set.add(key);
    }
    return [...set].sort();
  }, [visible]);
  const keySignature = keys.join("|");

  const refresh = useCallback(() => {
    void resolveVisibleText({
      cells: visible,
      agentId,
      refetch: () => refetchRef.current(),
      cache,
    });
  }, [visible, agentId, cache]);

  useEffect(() => {
    const missing = keys.some((key) => !cache.has(key));
    if (!missing) return;
    void resolveVisibleText({
      cells: visible,
      agentId,
      refetch: () => refetchRef.current(),
      cache,
    });
    // `keySignature` stands in for `keys`, which is a fresh array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySignature, agentId, cache]);

  const textFor = useCallback(
    (cell: TrajectoryCellProps) => {
      const key = textKey(cell);
      return key === null ? undefined : cache.get(key);
    },
    [cache],
  );

  return { cache, textFor, refresh };
}
