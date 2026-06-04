/**
 * Subgraph GraphQL client — the API's history/aggregate source. Designed for
 * graceful degradation: the subgraph is NOT deployed yet, so with no `url`
 * configured (or an unreachable endpoint) every call returns a typed degraded
 * result and the handler emits a `pending` body — the request NEVER throws.
 *
 * Injectable `fetchImpl` keeps tests OFFLINE: pass a mock fetch (or a fake query
 * runner) and no live network is touched.
 */

export interface SubgraphConfig {
  /** The deployed subgraph GraphQL endpoint. Absent ⇒ every query degrades. */
  url?: string
  /** Injected fetch (tests/offline). Defaults to global fetch when present. */
  fetchImpl?: typeof fetch
  /** Request timeout (ms). */
  timeoutMs?: number
}

export type SubgraphOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'not-configured' | 'unreachable' | 'graphql-error'; detail: string }

export class SubgraphClient {
  private readonly url: string | undefined
  private readonly fetchImpl: typeof fetch | undefined
  private readonly timeoutMs: number

  constructor(cfg: SubgraphConfig = {}) {
    this.url = cfg.url
    this.fetchImpl = cfg.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined)
    this.timeoutMs = cfg.timeoutMs ?? 8_000
  }

  /** True iff a subgraph endpoint is configured (does NOT prove reachability). */
  get configured(): boolean {
    return this.url !== undefined && this.url.length > 0
  }

  /**
   * Run a GraphQL query. Returns a typed outcome; never throws. A missing url, a
   * network failure, or a GraphQL `errors` payload all map to a degraded outcome.
   */
  async query<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<SubgraphOutcome<T>> {
    if (this.url === undefined || this.url.length === 0) {
      return {
        ok: false,
        reason: 'not-configured',
        detail: 'no subgraph url configured (not deployed yet)',
      }
    }
    const doFetch = this.fetchImpl
    if (doFetch === undefined) {
      return { ok: false, reason: 'unreachable', detail: 'no fetch implementation available' }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await doFetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      })
      if (!res.ok) {
        return { ok: false, reason: 'unreachable', detail: `subgraph HTTP ${res.status}` }
      }
      const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
      if (json.errors !== undefined && json.errors.length > 0) {
        return {
          ok: false,
          reason: 'graphql-error',
          detail: json.errors.map((e) => e.message).join('; '),
        }
      }
      if (json.data === undefined) {
        return { ok: false, reason: 'graphql-error', detail: 'subgraph returned no data' }
      }
      return { ok: true, data: json.data }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return { ok: false, reason: 'unreachable', detail }
    } finally {
      clearTimeout(timer)
    }
  }
}
