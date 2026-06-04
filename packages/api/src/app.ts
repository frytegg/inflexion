/**
 * The HTTP app — a framework-free `node:http` request handler over the pure
 * handlers in handlers.ts. No external web framework (matches packages/engine's
 * node:http style; offline-test-friendly). All responses are JSON, bigint-safe,
 * read-only, and cached per-route. CORS-open (public data).
 *
 * Routes (docs/ACCESS_LAYER_ARCHITECTURE.md §7.1):
 *   GET /health
 *   GET /openapi.json                                  (OpenAPI 3.1 document)
 *   GET /docs                                          (Swagger-UI shell)
 *   GET /markets
 *   GET /markets/:id
 *   GET /pool?marketIds=0x..,0x..                      (LIVE vault state, claim B)
 *   GET /pool/load-surface?marketIds=0x..,0x..         (LIVE, SDK multicall)
 *   GET /pool/nav-history?bucket=day|hour              (subgraph, claim B)
 *   GET /pricing/preview?marketId&a&b&maxIL            (LIVE cached, SDK pricing)
 *   GET /swaps?status&mm&market&first                  (subgraph list, claim A)
 *   GET /swaps/:swapId                                 (subgraph, claim A)
 *   GET /data/load-surface?marketId                    (historical, subgraph)
 *   GET /data/convexity-surface                        (Signal 1/2)
 *   GET /data/term-structure?width&distance            (Signal 3)
 *   GET /data/demand-requests?marketId&since           (Signal 4: realized+latent)
 *   GET /data/quote-competition?marketId&since         (Signal 2 dynamic)
 *   GET /data/net-gamma                                (Signal 5)
 *   GET /data/supply-depth                             (Signal 5 raw active set)
 *   GET /mm/:address/fills
 *   GET /sigma/:token/history
 */
import { type IncomingMessage, type ServerResponse } from 'node:http'
import type { Hex } from 'viem'
import {
  type HandlerDeps,
  getMarkets,
  getMarketById,
  getPoolState,
  getPricingPreview,
  getCurrentLoadSurface,
  getLoadSurfaceHistory,
  getConvexitySurface,
  getTermStructure,
  getDemandRequests,
  getQuoteCompetition,
  getNetGamma,
  getSupplyDepth,
  getNavHistory,
  getMmFills,
  getSwaps,
  getSwapById,
  getSigmaHistory,
} from './handlers.js'
import { OPENAPI_DOCUMENT, DOCS_HTML } from './openapi.js'

/** JSON.stringify with bigint → decimal-string coercion (bigint-safe wire format). */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, jsonReplacer)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=5',
  })
  res.end(payload)
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=300',
  })
  res.end(html)
}

function isHex(s: string | null): s is Hex {
  return s !== null && /^0x[0-9a-fA-F]+$/.test(s)
}

/** Parse a comma-separated list of bytes32 marketIds from a query param. */
function parseMarketIds(raw: string | null): Hex[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is Hex => isHex(s))
}

/** Parse a positive-integer-as-WAD/raw bigint query param, or undefined. */
function parseBigint(raw: string | null): bigint | undefined {
  if (raw === null || !/^\d+$/.test(raw)) return undefined
  try {
    return BigInt(raw)
  } catch {
    return undefined
  }
}

/**
 * Build the request handler. Pure deps in → an http listener out (so the same
 * app is driven by server.ts AND by offline tests that call `handle` directly).
 */
export function createApp(deps: HandlerDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void route(deps, req, res).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err)
      // The handlers never throw by design; this is a last-resort guard so a bug
      // returns a typed 500 rather than crashing the process.
      send(res, 500, { available: false, reason: 'internal', detail })
    })
  }
}

async function route(deps: HandlerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type',
    })
    res.end()
    return
  }
  if (req.method !== 'GET') {
    send(res, 405, {
      available: false,
      reason: 'method-not-allowed',
      detail: 'read-only API; GET only',
    })
    return
  }

  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const q = url.searchParams

  // ── /health ──
  if (path === '/health') {
    send(res, 200, {
      ok: true,
      subgraph: deps.subgraph.configured,
      live: deps.data !== undefined,
      telemetry: {
        demand: deps.telemetry.demandEnabled,
        competition: deps.telemetry.competitionEnabled,
      },
    })
    return
  }

  // ── /openapi.json + /docs ──
  if (path === '/openapi.json') {
    send(res, 200, OPENAPI_DOCUMENT)
    return
  }
  if (path === '/docs' || path === '/docs/') {
    sendHtml(res, 200, DOCS_HTML)
    return
  }

  // ── /markets and /markets/:id ──
  if (path === '/markets') {
    send(res, 200, await getMarkets(deps))
    return
  }
  const marketMatch = /^\/markets\/(0x[0-9a-fA-F]{64})$/.exec(path)
  if (marketMatch) {
    send(res, 200, await getMarketById(deps, marketMatch[1]!))
    return
  }

  // ── LIVE vault state composite (claim B) ──
  if (path === '/pool') {
    send(res, 200, await getPoolState(deps, parseMarketIds(q.get('marketIds'))))
    return
  }

  // ── LIVE current load surface (SDK multicall) ──
  if (path === '/pool/load-surface') {
    send(res, 200, await getCurrentLoadSurface(deps, parseMarketIds(q.get('marketIds'))))
    return
  }

  // ── /pool/nav-history ──
  if (path === '/pool/nav-history') {
    const bucket = q.get('bucket') === 'hour' ? 'hour' : 'day'
    send(res, 200, await getNavHistory(deps, bucket))
    return
  }

  // ── LIVE cached pricing preview (SDK current-load surface) ──
  if (path === '/pricing/preview') {
    const marketId = q.get('marketId')
    if (!isHex(marketId) || !/^0x[0-9a-fA-F]{64}$/.test(marketId)) {
      send(res, 400, {
        available: false,
        reason: 'bad-request',
        detail: 'marketId (bytes32 hex) required',
      })
      return
    }
    const aWad = parseBigint(q.get('a'))
    const bWad = parseBigint(q.get('b'))
    const maxIL = parseBigint(q.get('maxIL'))
    send(
      res,
      200,
      await getPricingPreview(deps, {
        marketId,
        ...(aWad !== undefined ? { aWad } : {}),
        ...(bWad !== undefined ? { bWad } : {}),
        ...(maxIL !== undefined ? { maxIL } : {}),
      }),
    )
    return
  }

  // ── /data/* (the five signals) ──
  if (path === '/data/load-surface') {
    const marketId = q.get('marketId') ?? ''
    send(res, 200, await getLoadSurfaceHistory(deps, marketId))
    return
  }
  if (path === '/data/convexity-surface') {
    send(res, 200, await getConvexitySurface(deps))
    return
  }
  if (path === '/data/term-structure') {
    const width = q.get('width') ?? 'medium'
    const distance = q.get('distance') ?? 'mid'
    send(res, 200, await getTermStructure(deps, width, distance))
    return
  }
  if (path === '/data/demand-requests') {
    send(res, 200, await getDemandRequests(deps, parseFilter(q)))
    return
  }
  if (path === '/data/quote-competition') {
    send(res, 200, await getQuoteCompetition(deps, parseFilter(q)))
    return
  }
  if (path === '/data/net-gamma') {
    send(res, 200, await getNetGamma(deps))
    return
  }
  if (path === '/data/supply-depth') {
    send(res, 200, await getSupplyDepth(deps))
    return
  }

  // ── /mm/:address/fills ──
  const mmMatch = /^\/mm\/(0x[0-9a-fA-F]{40})\/fills$/.exec(path)
  if (mmMatch) {
    send(res, 200, await getMmFills(deps, mmMatch[1]!))
    return
  }

  // ── /swaps (list) ──
  if (path === '/swaps') {
    const status = q.get('status')
    const mm = q.get('mm')
    const market = q.get('market')
    const first = q.get('first')
    send(
      res,
      200,
      await getSwaps(deps, {
        ...(status === 'active' || status === 'settled' ? { status } : {}),
        ...(mm !== null && /^0x[0-9a-fA-F]{40}$/.test(mm) ? { mm } : {}),
        ...(market !== null && /^0x[0-9a-fA-F]{64}$/.test(market) ? { market } : {}),
        ...(first !== null && /^\d+$/.test(first) ? { first: Number(first) } : {}),
      }),
    )
    return
  }

  // ── /swaps/:swapId ──
  const swapMatch = /^\/swaps\/(\d+)$/.exec(path)
  if (swapMatch) {
    send(res, 200, await getSwapById(deps, swapMatch[1]!))
    return
  }

  // ── /sigma/:token/history ──
  const sigmaMatch = /^\/sigma\/(0x[0-9a-fA-F]{40})\/history$/.exec(path)
  if (sigmaMatch) {
    send(res, 200, await getSigmaHistory(deps, sigmaMatch[1]!))
    return
  }

  send(res, 404, { available: false, reason: 'not-found', detail: `no route for ${path}` })
}

function parseFilter(q: URLSearchParams): { marketId?: string; since?: number } {
  const out: { marketId?: string; since?: number } = {}
  const marketId = q.get('marketId')
  if (marketId !== null && /^0x[0-9a-fA-F]{64}$/.test(marketId))
    out.marketId = marketId.toLowerCase()
  const since = q.get('since')
  if (since !== null && /^\d+$/.test(since)) out.since = Number(since)
  return out
}
