/**
 * Shared API response envelopes. Every endpoint returns one of these so a consumer
 * can discriminate `available` vs a typed degraded result WITHOUT the request ever
 * throwing. The subgraph is NOT deployed yet (and the rich SwapPriced/QuoteFilled
 * events are not live until the single redeploy), so subgraph-backed endpoints
 * return `pending` today; the LIVE endpoints (current load surface, telemetry)
 * return real data NOW.
 */

/** Why a subgraph-backed surface is unavailable today. */
export type PendingReason =
  | 'subgraph-not-deployed'
  | 'subgraph-unreachable'
  | 'rich-events-pre-redeploy'
  | 'telemetry-sink-absent'
  | 'rpc-unavailable'

/** A typed "not available yet" body. Carries the future GraphQL query so the
 *  surface is self-documenting and wired-and-ready for the redeploy. */
export interface Pending {
  available: false
  reason: PendingReason
  /** Human note describing what unblocks this surface. */
  detail: string
  /** The GraphQL query string the surface WILL run once the subgraph is live. */
  query?: string
}

/** A successful body merged with `available: true`. */
export type Available<T> = { available: true } & T

/** The discriminated union every handler returns. */
export type ApiResult<T> = Available<T> | Pending

/** Claim-(B) disclosure attached to every NAV/yield/pool surface. */
export const CLAIM_B_DISCLOSURE =
  'Depositor capital is NOT guaranteed: the junior tranche is first-loss; the senior ' +
  'tranche is structurally protected from underwriting loss only, not systemic tail.'

/** Claim-(A) disclosure attached to every payout surface. */
export const CLAIM_A_DISCLOSURE =
  'LPs are always paid with no bad debt in FULL mode — qualified: capped payoff + ' +
  'solvent USDC + oracle/settlement liveness.'

/** Maturity disclaimer attached to every moat-signal surface (§5.0). */
export const MATURITY_DISCLAIMER =
  'Structures ship from day one; the full DYNAMICS (pool-vs-MM spread as a forward-vol ' +
  'signal) mature with multiple competing MMs and volume. The dataset begins at the ' +
  'single redeploy; the off-chain telemetry halves begin at the first interaction logged.'

export function pending(reason: PendingReason, detail: string, query?: string): Pending {
  return query !== undefined
    ? { available: false, reason, detail, query }
    : { available: false, reason, detail }
}

export function available<T>(body: T): Available<T> {
  return { available: true, ...body }
}
