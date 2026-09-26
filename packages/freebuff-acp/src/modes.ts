import type { SessionMode } from "@agentclientprotocol/sdk";

/**
 * The Freebuff CLI runs a single curated mode (LITE). Expose it as an ACP
 * session mode so hosts can render it, and keep the mapping table small so
 * future modes slot in without protocol changes.
 */
export const DEFAULT_MODE_ID = "lite";

export const FREEBUFF_MODES: SessionMode[] = [
  {
    id: DEFAULT_MODE_ID,
    name: "Lite",
    description: "Freebuff default coding mode",
  },
];

export const FREEBUFF_MODE_IDS: ReadonlySet<string> = new Set(FREEBUFF_MODES.map((m) => m.id));

export function freebuffModeFromAcpModeId(modeId: string | undefined): string {
  if (modeId && FREEBUFF_MODE_IDS.has(modeId)) return modeId;
  return DEFAULT_MODE_ID;
}
