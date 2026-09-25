/**
 * Wire key of the Paseo ACP extension that marks a permission request as
 * spending credit: the host must never auto-accept it. The host defines the
 * same key in packages/server/src/server/agent/providers/acp-questions.ts;
 * permission-meta.test.ts there fails if the two drift apart.
 */
export const REQUIRE_APPROVAL_META_KEY = "paseo/requireApproval";

/** `_meta` for a permission request that spends the user's credit. */
export const REQUIRE_APPROVAL_META = { [REQUIRE_APPROVAL_META_KEY]: true } as const;
