/**
 * The thin Path-B relayer (P4.a). It does NOT match or settle — the chain does
 * that. It only:
 *   - accepts EIP-712 signed quotes streamed by a market maker over WebSocket,
 *     verifies the signature + basic freshness, and stores the latest;
 *   - serves the cheapest current quote for a market over `GET /quote`.
 *
 * The final premium is position-specific and derived ON-CHAIN at `createSwapRouted`
 * (`FairPremium · (1 + loadBps)`), so `/quote` returns the signed quote + its
 * `loadBps`; it does not (yet) compute a dollar premium (that needs the LP's
 * position geometry + an RPC read — added with the SDK in P4.b).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type Address, isAddress } from 'viem'
import { WebSocketServer } from 'ws'
import { QuoteStore } from './store.js'
import {
  type QuoteEnvelope,
  type QuoteWire,
  decodeQuote,
  encodeQuote,
  verifyQuote,
} from './quote.js'

export interface EngineConfig {
  port: number
  chainId: number
  verifyingContract: Address
  logPath?: string
  /** Reject quotes whose `validUntil` is already past, or more than this far out. */
  maxValiditySkewS?: number
  /** Injectable clock (seconds) for tests; defaults to wall clock. */
  nowSec?: () => number
}

export interface EngineHandle {
  http: Server
  wss: WebSocketServer
  store: QuoteStore
  close: () => Promise<void>
}

const json = (res: ServerResponse, code: number, body: unknown): void => {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Light, non-authoritative freshness gate (the chain re-checks everything). */
function freshnessOk(env: QuoteEnvelope, nowSec: number, maxSkewS: number): boolean {
  const validUntil = env.quote.validUntil
  if (validUntil <= BigInt(nowSec)) return false // already expired
  if (validUntil > BigInt(nowSec + maxSkewS)) return false // dated too far out
  return true
}

export function startEngine(cfg: EngineConfig): EngineHandle {
  const now = cfg.nowSec ?? (() => Math.floor(Date.now() / 1000))
  const maxSkewS = cfg.maxValiditySkewS ?? 60
  const store = new QuoteStore(cfg.logPath)

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true, markets: store.marketCount() })
      return
    }
    if (req.method === 'GET' && url.pathname === '/quote') {
      const marketId = url.searchParams.get('marketId')
      if (marketId === null || !/^0x[0-9a-fA-F]{64}$/.test(marketId)) {
        json(res, 400, { error: 'marketId (bytes32 hex) required' })
        return
      }
      const best = store.best(marketId, now())
      if (best === undefined) {
        json(res, 404, { error: 'no live quote for market', marketId })
        return
      }
      json(res, 200, {
        quote: encodeQuote(best.quote),
        signature: best.signature,
        loadBps: best.quote.loadBps,
        note: 'premium is FairPremium*(1+loadBps), derived on-chain at createSwapRouted',
      })
      return
    }
    json(res, 404, { error: 'not found' })
  })

  const wss = new WebSocketServer({ server: http })
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      void (async () => {
        let msg: { type?: string; quote?: QuoteWire; signature?: `0x${string}` }
        try {
          msg = JSON.parse(data.toString())
        } catch {
          ws.send(JSON.stringify({ type: 'error', error: 'invalid json' }))
          return
        }
        if (msg.type !== 'quote' || msg.quote === undefined || msg.signature === undefined) {
          ws.send(
            JSON.stringify({ type: 'error', error: "expected {type:'quote', quote, signature}" }),
          )
          return
        }
        const env: QuoteEnvelope = { quote: decodeQuote(msg.quote), signature: msg.signature }
        if (!isAddress(env.quote.mm)) {
          ws.send(JSON.stringify({ type: 'error', error: 'bad mm address' }))
          return
        }
        if (!freshnessOk(env, now(), maxSkewS)) {
          ws.send(JSON.stringify({ type: 'rejected', reason: 'stale-or-far-validUntil' }))
          return
        }
        const ok = await verifyQuote(env, cfg.chainId, cfg.verifyingContract)
        if (!ok) {
          ws.send(JSON.stringify({ type: 'rejected', reason: 'bad-signature' }))
          return
        }
        store.put(env, now())
        ws.send(
          JSON.stringify({ type: 'ack', marketId: env.quote.marketId, loadBps: env.quote.loadBps }),
        )
      })()
    })
  })

  http.listen(cfg.port)

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      wss.close(() => http.close(() => resolve()))
    })

  return { http, wss, store, close }
}
