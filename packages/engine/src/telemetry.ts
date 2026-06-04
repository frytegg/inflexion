/**
 * DAY-ONE TELEMETRY — the moat's two DYNAMIC signals are unreconstructable
 * retroactively, so the engine must capture them from the very first interaction,
 * long before any `/data` endpoint, subgraph, or API exposes them.
 *
 * On-chain we only ever observe REALIZED fills. Everything an LP priced but did
 * not buy (Signal 4 latent demand) and every MM quote that lost or was withdrawn
 * (Signal 2 dynamic half — quote competition) leaves no on-chain trace by design
 * (I7: an unchosen quote touches no nonce/capacity). If we don't log it now it is
 * gone forever. See docs/ENGINE_TELEMETRY.md and the access-layer spec §5.6.
 *
 * Storage is append-only JSONL (one JSON object per line), mirroring the existing
 * accepted-quote log in store.ts. The writer is best-effort: a telemetry failure
 * must NEVER break a quote ack, a preview, or a `/quote` request — graceful
 * degradation is a first-class property of this engine.
 */
import { appendFileSync } from 'node:fs'
import type { SignedQuote } from './quote.js'

// ─── Geometry buckets (no PII; coarse, privacy-preserving) ──────────────────
// Buckets keep the demand log free of raw position geometry / addresses while
// still letting the moat reconstruct the (width × distance × duration) demand
// surface. The SDK computes these client-side and POSTs only the bucket labels.

/** Coarse position-width bucket (tick span of the LP range). */
export type WidthBucket = 'tight' | 'medium' | 'wide' | 'full' | 'unknown'
/** Coarse distance-to-range-edge bucket (how near spot is to going out of range). */
export type DistanceBucket = 'at-edge' | 'near' | 'mid' | 'deep' | 'unknown'
/** Coarse protection-duration bucket (expiry − createdAt). */
export type DurationBucket = 'hour' | 'day' | 'week' | 'month' | 'longer' | 'unknown'

const WIDTH_BUCKETS: readonly WidthBucket[] = ['tight', 'medium', 'wide', 'full', 'unknown']
const DISTANCE_BUCKETS: readonly DistanceBucket[] = ['at-edge', 'near', 'mid', 'deep', 'unknown']
const DURATION_BUCKETS: readonly DurationBucket[] = [
  'hour',
  'day',
  'week',
  'month',
  'longer',
  'unknown',
]

function asWidthBucket(v: unknown): WidthBucket {
  return typeof v === 'string' && (WIDTH_BUCKETS as readonly string[]).includes(v)
    ? (v as WidthBucket)
    : 'unknown'
}
function asDistanceBucket(v: unknown): DistanceBucket {
  return typeof v === 'string' && (DISTANCE_BUCKETS as readonly string[]).includes(v)
    ? (v as DistanceBucket)
    : 'unknown'
}
function asDurationBucket(v: unknown): DurationBucket {
  return typeof v === 'string' && (DURATION_BUCKETS as readonly string[]).includes(v)
    ? (v as DurationBucket)
    : 'unknown'
}

// ─── Record schemas (the on-disk JSONL shapes) ──────────────────────────────

/**
 * Signal 4 (latent demand) record — one per `/quote` request or SDK
 * `previewPremium` ping. `filled` is always `false` at write time: this log is
 * exactly the demand the chain never sees (unfilled / previewed-but-not-bought).
 * Realized fills are reconstructed later from on-chain `SwapCreated`.
 *
 * Schema is the task-mandated minimum: no raw geometry, no tokenId, no PII —
 * only coarse buckets + the marketId.
 */
export interface DemandRecord {
  ts: number
  marketId: string
  widthBucket: WidthBucket
  distanceBucket: DistanceBucket
  durationBucket: DurationBucket
  /** Premium the SDK previewed for this geometry (decimal string; bigint-safe). Absent for a bare /quote request. */
  previewedPremium?: string
  /** Always false — this is the latent/unfilled half of the demand curve. */
  filled: false
  /** What produced the record (a relayer /quote lookup vs an SDK previewPremium ping). */
  source: 'quote-request' | 'preview'
}

/**
 * Signal 2 (dynamic half — quote competition) record — one per quote the relayer
 * receives over WS, WINNERS AND LOSERS. Only ever logging the latest stored quote
 * (as store.ts does) loses the competition: who else quoted, how wide, and who
 * widened/withdrew under stress. `accepted` marks whether the relayer stored it
 * as a candidate (signature + freshness valid); a rejected quote still competed.
 */
export interface CompetitionRecord {
  ts: number
  marketId: string
  mm: string
  loadBps: number
  /** Quote GTD expiry (uint64 as decimal string; bigint-safe). */
  validUntil: string
  /** True iff the relayer accepted it as a live candidate (passed verify+freshness). */
  accepted: boolean
  /** When not accepted, why (mirrors the WS rejection reason). */
  reason?: string
}

// ─── Best-effort JSONL writer ───────────────────────────────────────────────

/** Append one record as a JSON line. Never throws — telemetry must not block. */
function appendJsonl(path: string | undefined, record: unknown): boolean {
  if (path === undefined) return false
  try {
    appendFileSync(path, JSON.stringify(record) + '\n')
    return true
  } catch {
    // Best-effort: a full disk / bad path must not break a quote, preview, or
    // request. Swallow and report the no-op to the caller.
    return false
  }
}

// ─── Preview ping (the SDK's best-effort POST body) ─────────────────────────

/** Loosely-typed body the SDK POSTs to /telemetry/preview (all fields optional/validated). */
export interface PreviewPingInput {
  marketId?: unknown
  widthBucket?: unknown
  distanceBucket?: unknown
  durationBucket?: unknown
  previewedPremium?: unknown
}

/** Outcome of accepting a preview ping (typed degraded result; never throws). */
export interface IngestResult {
  ok: boolean
  /** True iff the record was actually written to the JSONL sink. */
  logged: boolean
  reason?: string
}

function normalizeMarketId(v: unknown): string | undefined {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v) ? v.toLowerCase() : undefined
}

/** Coerce an arbitrary previewedPremium into a bigint-safe decimal string, or drop it. */
function normalizePremium(v: unknown): string | undefined {
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return v
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.trunc(v).toString()
  if (typeof v === 'bigint' && v >= 0n) return v.toString()
  return undefined
}

/**
 * The day-one telemetry sink. Wraps the two append-only JSONL logs and exposes
 * the typed ingest entrypoints used by server.ts and store.ts. All methods are
 * best-effort and return typed results; none throw on a missing path / bad disk.
 */
export class TelemetrySink {
  constructor(
    private readonly demandLogPath?: string,
    private readonly competitionLogPath?: string,
  ) {}

  /** True iff the demand log is configured (a sink path was supplied). */
  get demandEnabled(): boolean {
    return this.demandLogPath !== undefined
  }

  /** True iff the competition log is configured. */
  get competitionEnabled(): boolean {
    return this.competitionLogPath !== undefined
  }

  /**
   * Log a bare `/quote` request: an LP (or the SDK) asked the relayer for the
   * best quote on a market — latent demand even if no swap follows.
   */
  logQuoteRequest(marketId: string, now: number): boolean {
    const rec: DemandRecord = {
      ts: now,
      marketId: marketId.toLowerCase(),
      widthBucket: 'unknown',
      distanceBucket: 'unknown',
      durationBucket: 'unknown',
      filled: false,
      source: 'quote-request',
    }
    return appendJsonl(this.demandLogPath, rec)
  }

  /**
   * Ingest an SDK `previewPremium` ping (the bucketed geometry an LP priced).
   * Validates + normalizes the loosely-typed POST body and returns a typed
   * degraded result; a missing/invalid marketId is reported, never thrown.
   */
  ingestPreview(input: PreviewPingInput, now: number): IngestResult {
    const marketId = normalizeMarketId(input.marketId)
    if (marketId === undefined) {
      return { ok: false, logged: false, reason: 'marketId (bytes32 hex) required' }
    }
    const previewedPremium = normalizePremium(input.previewedPremium)
    const rec: DemandRecord = {
      ts: now,
      marketId,
      widthBucket: asWidthBucket(input.widthBucket),
      distanceBucket: asDistanceBucket(input.distanceBucket),
      durationBucket: asDurationBucket(input.durationBucket),
      ...(previewedPremium !== undefined ? { previewedPremium } : {}),
      filled: false,
      source: 'preview',
    }
    const logged = appendJsonl(this.demandLogPath, rec)
    return { ok: true, logged }
  }

  /**
   * Log a quote the relayer received over WS — WINNERS AND LOSERS. Called for
   * every inbound quote regardless of whether it was stored, so the competition
   * log captures the full field (and who widened/withdrew), not just the latest.
   */
  logQuote(quote: SignedQuote, accepted: boolean, now: number, reason?: string): boolean {
    const rec: CompetitionRecord = {
      ts: now,
      marketId: quote.marketId.toLowerCase(),
      mm: quote.mm.toLowerCase(),
      loadBps: quote.loadBps,
      validUntil: quote.validUntil.toString(),
      accepted,
      ...(reason !== undefined ? { reason } : {}),
    }
    return appendJsonl(this.competitionLogPath, rec)
  }
}
