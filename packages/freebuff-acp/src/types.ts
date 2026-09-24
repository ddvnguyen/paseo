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
  /** Wallet/quota block on GET /session; feeds the open-session confirm dialog. */
  freebucks?: {
    balance?: number;
    daily?: { limit?: number; spent?: number; remaining?: number; resetAt?: string };
    wallet?: { balance?: number; monthlyBonus?: number };
    prices?: Record<string, number>;
    /** Human notes on a model's price (peak/off-peak, trials). */
    priceNotices?: Record<string, string>;
  };
}

export interface FreebuffCredentials {
  token: string;
}
