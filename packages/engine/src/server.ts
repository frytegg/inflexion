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
 *
 * `createEngineParts` exposes the bare request handler + WS attach so the relayer
 * can be mounted in-process behind a shared HTTP server (the combined `apps/backend`
 * deploy), where the API reads the same telemetry files the engine writes.
 * `startEngine` is the standalone server (local dev + tests) built on those parts.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type Address, isAddress } from 'viem'
import { WebSocketServer } from 'ws'
import { QuoteStore } from './store.js'
import { type PreviewPingInput, TelemetrySink } from './telemetry.js'
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
  /**
   * Day-one telemetry sink for Signal 4 (latent demand): every `/quote` request +
   * SDK `previewPremium` ping is appended here as JSONL. Off-chain only — unfilled
   * interest never reaches the chain (I7). See docs/ENGINE_TELEMETRY.md.
   */
  demandLogPath?: string
  /**
   * Day-one telemetry sink for Signal 2 (dynamic half — quote competition): EVERY
   * WS quote the relayer receives (winners AND losers) is appended here as JSONL,
   * not just the latest stored one.
   */
  competitionLogPath?: string
  /** Reject quotes whose `validUntil` is already past, or more than this far out. */
  maxValiditySkewS?: number
  /** Injectable clock (seconds) for tests; defaults to wall clock. */
  nowSec?: () => number
}

export interface EngineParts {
  /** node:http request listener for the relayer's HTTP routes. */
  handler: (req: IncomingMessage, res: ServerResponse) => void
  /** Attach the MM quote-stream WebSocket to a server (shares the http listener). */
  attachWs: (server: Server) => WebSocketServer
  store: QuoteStore
  telemetry: TelemetrySink
}

export interface EngineHandle {
  http: Server
  wss: WebSocketServer
  store: QuoteStore
  telemetry: TelemetrySink
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

/** Read a request body up to `maxBytes`, parse as JSON; typed degraded result on failure. */
function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    let done = false
    const finish = (r: { ok: true; value: unknown } | { ok: false; reason: string }): void => {
      if (done) return
      done = true
      resolve(r)
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        finish({ ok: false, reason: 'body too large' })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.length === 0) {
        finish({ ok: true, value: {} })
        return
      }
      try {
        finish({ ok: true, value: JSON.parse(raw) })
      } catch {
        finish({ ok: false, reason: 'invalid json' })
      }
    })
    req.on('error', () => finish({ ok: false, reason: 'request error' }))
  })
}

/**
 * Build the relayer's request handler + WS attach without binding a port. Lets the
 * engine be mounted in-process (combined deploy) or run standalone (`startEngine`).
 */
export function createEngineParts(cfg: EngineConfig): EngineParts {
  const now = cfg.nowSec ?? (() => Math.floor(Date.now() / 1000))
  const maxSkewS = cfg.maxValiditySkewS ?? 60
  const store = new QuoteStore(cfg.logPath)
  const telemetry = new TelemetrySink(cfg.demandLogPath, cfg.competitionLogPath)

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    // CORS — the browser dApp (different origin) reads GET /quote (previewPremium)
    // and publishes POST /quote (MM signing). Allow any origin; no credentials.
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'content-type')
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, {
        ok: true,
        markets: store.marketCount(),
        telemetry: { demand: telemetry.demandEnabled, competition: telemetry.competitionEnabled },
      })
      return
    }
    // Day-one Signal 4 sink: the SDK's previewPremium best-effort POST. The body
    // carries only bucketed geometry + marketId (no PII). Always 202-acks fast and
    // never blocks the preview — a telemetry failure is reported as logged:false.
    if (req.method === 'POST' && url.pathname === '/telemetry/preview') {
      void (async () => {
        const body = await readJsonBody(req, 4096)
        if (!body.ok) {
          json(res, 400, { ok: false, reason: body.reason })
          return
        }
        const input = (body.value ?? {}) as PreviewPingInput
        const result = telemetry.ingestPreview(input, now())
        json(res, result.ok ? 202 : 400, result)
      })()
      return
    }
    // Browser-friendly publish (the WS path stays for the mm-bot). Same verify +
    // freshness + store as the WS handler; body is the wire envelope.
    if (req.method === 'POST' && url.pathname === '/quote') {
      void (async () => {
        const body = await readJsonBody(req, 8192)
        if (!body.ok) {
          json(res, 400, { error: body.reason })
          return
        }
        const msg = (body.value ?? {}) as { quote?: QuoteWire; signature?: `0x${string}` }
        if (msg.quote === undefined || msg.signature === undefined) {
          json(res, 400, { error: 'expected { quote, signature }' })
          return
        }
        const env: QuoteEnvelope = { quote: decodeQuote(msg.quote), signature: msg.signature }
        if (!isAddress(env.quote.mm)) {
          json(res, 400, { error: 'bad mm address' })
          return
        }
        if (!freshnessOk(env, now(), maxSkewS)) {
          telemetry.logQuote(env.quote, false, now(), 'stale-or-far-validUntil')
          json(res, 422, { rejected: true, reason: 'stale-or-far-validUntil' })
          return
        }
        const ok = await verifyQuote(env, cfg.chainId, cfg.verifyingContract)
        if (!ok) {
          telemetry.logQuote(env.quote, false, now(), 'bad-signature')
          json(res, 422, { rejected: true, reason: 'bad-signature' })
          return
        }
        telemetry.logQuote(env.quote, true, now())
        store.put(env, now())
        json(res, 200, { ok: true, marketId: env.quote.marketId, loadBps: env.quote.loadBps })
      })()
      return
    }
    if (req.method === 'GET' && url.pathname === '/quote') {
      const marketId = url.searchParams.get('marketId')
      if (marketId === null || !/^0x[0-9a-fA-F]{64}$/.test(marketId)) {
        json(res, 400, { error: 'marketId (bytes32 hex) required' })
        return
      }
      // Day-one Signal 4: log the REQUEST itself (latent demand) before answering —
      // best-effort, never blocks the response.
      telemetry.logQuoteRequest(marketId, now())
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
  }

  const attachWs = (server: Server): WebSocketServer => {
    const wss = new WebSocketServer({ server })
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
          // Day-one Signal 2 (quote competition): log EVERY received quote — winners
          // AND losers/withdrawn — with `accepted` set per-outcome below. The chain
          // only ever sees the realized fill, so the full competing field is lost
          // unless captured here. Logging is best-effort and never blocks the ack.
          if (!freshnessOk(env, now(), maxSkewS)) {
            telemetry.logQuote(env.quote, false, now(), 'stale-or-far-validUntil')
            ws.send(JSON.stringify({ type: 'rejected', reason: 'stale-or-far-validUntil' }))
            return
          }
          const ok = await verifyQuote(env, cfg.chainId, cfg.verifyingContract)
          if (!ok) {
            telemetry.logQuote(env.quote, false, now(), 'bad-signature')
            ws.send(JSON.stringify({ type: 'rejected', reason: 'bad-signature' }))
            return
          }
          telemetry.logQuote(env.quote, true, now())
          store.put(env, now())
          ws.send(
            JSON.stringify({
              type: 'ack',
              marketId: env.quote.marketId,
              loadBps: env.quote.loadBps,
            }),
          )
        })()
      })
    })
    return wss
  }

  return { handler, attachWs, store, telemetry }
}

export function startEngine(cfg: EngineConfig): EngineHandle {
  const parts = createEngineParts(cfg)
  const http = createServer(parts.handler)
  const wss = parts.attachWs(http)

  http.listen(cfg.port)

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      wss.close(() => http.close(() => resolve()))
    })

  return { http, wss, store: parts.store, telemetry: parts.telemetry, close }
}
