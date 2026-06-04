/**
 * Engine telemetry reader — the DYNAMIC halves of moat Signals 4 (latent demand)
 * and 2 (quote competition). These are captured day-one by the engine's
 * TelemetrySink into append-only JSONL sinks (docs/ENGINE_TELEMETRY.md):
 *   DEMAND_LOG       — DemandRecord    (Signal 4 latent demand)
 *   COMPETITION_LOG  — CompetitionRecord (Signal 2 dynamic half)
 *
 * The API reads these files (NOT a subgraph entity, NOT a contract event — putting
 * unfilled interest on-chain breaks I7 and costs gas) and serves aggregated views.
 * Reads degrade gracefully: an absent / unreadable sink yields `available:false`
 * (the request never throws), and the file reader is injectable for offline tests.
 */

/** DemandRecord — mirrors packages/engine/src/telemetry.ts. */
export interface DemandRecord {
  ts: number
  marketId: string
  widthBucket: string
  distanceBucket: string
  durationBucket: string
  previewedPremium?: string
  filled: false
  source: 'quote-request' | 'preview'
}

/** CompetitionRecord — mirrors packages/engine/src/telemetry.ts. */
export interface CompetitionRecord {
  ts: number
  marketId: string
  mm: string
  loadBps: number
  validUntil: string
  accepted: boolean
  reason?: string
}

/** Injectable file reader: returns the raw JSONL text, or undefined if absent. */
export type JsonlReader = (path: string) => string | undefined

export interface TelemetryConfig {
  demandLogPath?: string
  competitionLogPath?: string
  /** Injected reader (tests). Defaults to a best-effort fs read. */
  readJsonl?: JsonlReader
}

/** Default reader — best-effort synchronous fs read; never throws. */
function defaultReadJsonl(path: string): string | undefined {
  try {
    // Lazy require so the module imports cleanly in a no-fs context (and tests
    // that inject `readJsonl` never touch the filesystem).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs')
    if (!fs.existsSync(path)) return undefined
    return fs.readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function parseJsonl<T>(text: string | undefined): T[] {
  if (text === undefined) return []
  const out: T[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      out.push(JSON.parse(trimmed) as T)
    } catch {
      // Skip a malformed line — a partial last write must not break the read.
    }
  }
  return out
}

/** Aggregated latent-demand row (Signal 4 dynamic half). */
export interface DemandBucketAgg {
  marketId: string
  widthBucket: string
  distanceBucket: string
  durationBucket: string
  count: number
  previews: number
  quoteRequests: number
  firstSeen: number
  lastSeen: number
}

/** Aggregated quote-competition row per MM (Signal 2 dynamic half). */
export interface CompetitionAgg {
  marketId: string
  mm: string
  quotes: number
  accepted: number
  rejected: number
  minLoadBps: number
  maxLoadBps: number
  avgLoadBps: number
  lastSeen: number
}

export class TelemetryReader {
  private readonly demandPath: string | undefined
  private readonly competitionPath: string | undefined
  private readonly read: JsonlReader

  constructor(cfg: TelemetryConfig = {}) {
    this.demandPath = cfg.demandLogPath
    this.competitionPath = cfg.competitionLogPath
    this.read = cfg.readJsonl ?? defaultReadJsonl
  }

  get demandEnabled(): boolean {
    return this.demandPath !== undefined
  }
  get competitionEnabled(): boolean {
    return this.competitionPath !== undefined
  }

  /** Raw demand records (optionally filtered by marketId / since timestamp). */
  demandRecords(opts: { marketId?: string; since?: number } = {}): DemandRecord[] {
    if (this.demandPath === undefined) return []
    let recs = parseJsonl<DemandRecord>(this.read(this.demandPath))
    if (opts.marketId !== undefined) {
      const id = opts.marketId.toLowerCase()
      recs = recs.filter((r) => r.marketId === id)
    }
    if (opts.since !== undefined) {
      const since = opts.since
      recs = recs.filter((r) => r.ts >= since)
    }
    return recs
  }

  /** Latent-demand surface, aggregated by (market × width × distance × duration). */
  demandSurface(opts: { marketId?: string; since?: number } = {}): DemandBucketAgg[] {
    const byKey = new Map<string, DemandBucketAgg>()
    for (const r of this.demandRecords(opts)) {
      const key = `${r.marketId}-${r.widthBucket}-${r.distanceBucket}-${r.durationBucket}`
      let agg = byKey.get(key)
      if (agg === undefined) {
        agg = {
          marketId: r.marketId,
          widthBucket: r.widthBucket,
          distanceBucket: r.distanceBucket,
          durationBucket: r.durationBucket,
          count: 0,
          previews: 0,
          quoteRequests: 0,
          firstSeen: r.ts,
          lastSeen: r.ts,
        }
        byKey.set(key, agg)
      }
      agg.count += 1
      if (r.source === 'preview') agg.previews += 1
      else agg.quoteRequests += 1
      if (r.ts < agg.firstSeen) agg.firstSeen = r.ts
      if (r.ts > agg.lastSeen) agg.lastSeen = r.ts
    }
    return [...byKey.values()].sort((a, b) => b.count - a.count)
  }

  /** Raw competition records (optionally filtered). */
  competitionRecords(opts: { marketId?: string; since?: number } = {}): CompetitionRecord[] {
    if (this.competitionPath === undefined) return []
    let recs = parseJsonl<CompetitionRecord>(this.read(this.competitionPath))
    if (opts.marketId !== undefined) {
      const id = opts.marketId.toLowerCase()
      recs = recs.filter((r) => r.marketId === id)
    }
    if (opts.since !== undefined) {
      const since = opts.since
      recs = recs.filter((r) => r.ts >= since)
    }
    return recs
  }

  /** Quote-competition surface, aggregated per (market × MM). */
  competitionSurface(opts: { marketId?: string; since?: number } = {}): CompetitionAgg[] {
    const byKey = new Map<string, CompetitionAgg & { _sumLoad: number }>()
    for (const r of this.competitionRecords(opts)) {
      const key = `${r.marketId}-${r.mm}`
      let agg = byKey.get(key)
      if (agg === undefined) {
        agg = {
          marketId: r.marketId,
          mm: r.mm,
          quotes: 0,
          accepted: 0,
          rejected: 0,
          minLoadBps: r.loadBps,
          maxLoadBps: r.loadBps,
          avgLoadBps: 0,
          lastSeen: r.ts,
          _sumLoad: 0,
        }
        byKey.set(key, agg)
      }
      agg.quotes += 1
      if (r.accepted) agg.accepted += 1
      else agg.rejected += 1
      if (r.loadBps < agg.minLoadBps) agg.minLoadBps = r.loadBps
      if (r.loadBps > agg.maxLoadBps) agg.maxLoadBps = r.loadBps
      agg._sumLoad += r.loadBps
      if (r.ts > agg.lastSeen) agg.lastSeen = r.ts
    }
    return [...byKey.values()]
      .map((a) => {
        const { _sumLoad, ...rest } = a
        return { ...rest, avgLoadBps: a.quotes > 0 ? _sumLoad / a.quotes : 0 }
      })
      .sort((a, b) => b.quotes - a.quotes)
  }
}
