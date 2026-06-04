/**
 * Tiny per-route TTL cache. The API is read-only and cached (the routing rule:
 * "frictionless public access, no wallet, no RPC key"). Keys are route+params;
 * values expire after the route's TTL. In-memory only — a process restart simply
 * re-warms; no external cache dependency (offline-test-safe).
 */

interface Entry<T> {
  value: T
  expiresAt: number
}

export class TtlCache {
  private readonly store = new Map<string, Entry<unknown>>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  get<T>(key: string): T | undefined {
    const e = this.store.get(key)
    if (e === undefined) return undefined
    if (e.expiresAt <= this.now()) {
      this.store.delete(key)
      return undefined
    }
    return e.value as T
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: this.now() + ttlMs })
  }

  /** Memoise an async producer behind the cache. Errors are NOT cached. */
  async wrap<T>(key: string, ttlMs: number, produce: () => Promise<T>): Promise<T> {
    const hit = this.get<T>(key)
    if (hit !== undefined) return hit
    const value = await produce()
    this.set(key, value, ttlMs)
    return value
  }

  clear(): void {
    this.store.clear()
  }
}

/** Per-route TTLs (ms) — straight from docs/ACCESS_LAYER_ARCHITECTURE.md §7.1. */
export const TTL = {
  markets: 60_000,
  marketById: 5_000,
  pricingPreview: 3_000,
  fairPremiumCurve: 30_000,
  quote: 1_000,
  navHistory: 60_000,
  timeseries: 60_000,
  poolState: 5_000,
  mmFills: 30_000,
  marketVolume: 30_000,
  swapById: 5_000,
  loadSurface: 60_000,
  convexitySurface: 300_000,
  supplyDepth: 60_000,
  sigmaHistory: 60_000,
  netGamma: 60_000,
  demandRequests: 30_000,
  quoteCompetition: 30_000,
} as const
