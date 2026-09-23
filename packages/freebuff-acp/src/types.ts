/**
 * Minimal wire types for the Freebuff session API, mirroring
 * `@codebuff/common/types/freebuff-session` upstream. Only fields the adapter
 * reads are named; everything else stays open so server additions don't break
 * parsing.
 */
export interface FreebuffSessionServerResponse {
  status: string;
  message?: string;
  instanceId?: string;
  model?: string;
  accessTier?: string;
}

export interface FreebuffCredentials {
  token: string;
}
