/**
 * In-memory quote store for the thin relayer: the latest quote per (market, MM),
 * with an optional append-only JSONL log. "Best" = the cheapest currently-valid
 * quote (lowest `loadBps`, not expired) — the router still re-checks everything
 * on-chain, so this is only a convenience surface for takers.
 */
import { appendFileSync } from 'node:fs'
import { type QuoteEnvelope, encodeQuote } from './quote.js'

interface StoredQuote {
  env: QuoteEnvelope
  receivedAt: number
}

export class QuoteStore {
  /** marketId (lowercased) → mm (lowercased) → latest stored quote. */
  private readonly byMarket = new Map<string, Map<string, StoredQuote>>()

  constructor(private readonly logPath?: string) {}

  /** Store (or replace) the latest quote for its (market, MM) and append to the log. */
  put(env: QuoteEnvelope, now: number): void {
    const market = env.quote.marketId.toLowerCase()
    const mm = env.quote.mm.toLowerCase()
    let perMm = this.byMarket.get(market)
    if (!perMm) {
      perMm = new Map()
      this.byMarket.set(market, perMm)
    }
    perMm.set(mm, { env, receivedAt: now })
    if (this.logPath !== undefined) {
      const line = JSON.stringify({
        t: now,
        quote: encodeQuote(env.quote),
        signature: env.signature,
      })
      appendFileSync(this.logPath, line + '\n')
    }
  }

  /** Cheapest currently-valid quote for a market (lowest loadBps, not expired). */
  best(marketId: string, nowSec: number): QuoteEnvelope | undefined {
    const perMm = this.byMarket.get(marketId.toLowerCase())
    if (perMm === undefined) return undefined
    const cutoff = BigInt(nowSec)
    let best: QuoteEnvelope | undefined
    for (const { env } of perMm.values()) {
      if (env.quote.validUntil <= cutoff) continue // expired
      if (best === undefined || env.quote.loadBps < best.quote.loadBps) best = env
    }
    return best
  }

  /** Number of markets currently holding at least one quote. */
  marketCount(): number {
    return this.byMarket.size
  }
}
