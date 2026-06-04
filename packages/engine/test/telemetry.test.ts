import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { type CompetitionRecord, type DemandRecord, TelemetrySink } from '../src/telemetry.js'
import { type SignedQuote, CollateralModel, encodeQuote, signQuote } from '../src/quote.js'
import { type EngineHandle, startEngine } from '../src/server.js'

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const ACCOUNT = privateKeyToAccount(PK)
const CHAIN_ID = 421614
const CORE = '0x15b74EfcAB40A08281C0Cea972BeE0bbA1a9A96d' as Address
const MARKET = `0x${'ab'.repeat(32)}` as Hex
const NOW = 1_900_000_000

function quote(overrides: Partial<SignedQuote> = {}): SignedQuote {
  return {
    mm: ACCOUNT.address,
    marketId: MARKET,
    loadBps: 500,
    minMaxILRatioBps: 0,
    maxMaxILRatioBps: 10_000,
    quotePrice: 3000_00000000n,
    priceBandBps: 100,
    model: CollateralModel.FULL,
    partialRatioBps: 0,
    maxNotionalV0: (1n << 128n) - 1n,
    validUntil: BigInt(NOW + 10),
    quoteId: `0x${'00'.repeat(31)}01` as Hex,
    nonce: 1n,
    ...overrides,
  }
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as T)
}

describe('TelemetrySink (unit)', () => {
  let dir: string
  let demandLog: string
  let competitionLog: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'inflexion-tele-'))
    demandLog = join(dir, 'demand.jsonl')
    competitionLog = join(dir, 'competition.jsonl')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('logs a bare /quote request as latent demand (filled:false, unknown buckets)', () => {
    const sink = new TelemetrySink(demandLog, competitionLog)
    expect(sink.demandEnabled).toBe(true)
    expect(sink.logQuoteRequest(MARKET, NOW)).toBe(true)
    const recs = readJsonl<DemandRecord>(demandLog)
    expect(recs).toHaveLength(1)
    const r = recs[0]!
    expect(r).toMatchObject({
      ts: NOW,
      marketId: MARKET.toLowerCase(),
      widthBucket: 'unknown',
      distanceBucket: 'unknown',
      durationBucket: 'unknown',
      filled: false,
      source: 'quote-request',
    })
  })

  it('ingests a preview ping with bucketed geometry + premium (Signal 4 schema)', () => {
    const sink = new TelemetrySink(demandLog, competitionLog)
    const result = sink.ingestPreview(
      {
        marketId: MARKET,
        widthBucket: 'tight',
        distanceBucket: 'at-edge',
        durationBucket: 'week',
        previewedPremium: '123456789',
      },
      NOW,
    )
    expect(result).toEqual({ ok: true, logged: true })
    const recs = readJsonl<DemandRecord>(demandLog)
    expect(recs).toHaveLength(1)
    expect(recs[0]).toEqual({
      ts: NOW,
      marketId: MARKET.toLowerCase(),
      widthBucket: 'tight',
      distanceBucket: 'at-edge',
      durationBucket: 'week',
      previewedPremium: '123456789',
      filled: false,
      source: 'preview',
    })
  })

  it('coerces unknown buckets and drops a bad premium (graceful, no throw)', () => {
    const sink = new TelemetrySink(demandLog, competitionLog)
    const result = sink.ingestPreview(
      {
        marketId: MARKET,
        widthBucket: 'nonsense',
        distanceBucket: 42,
        durationBucket: null,
        previewedPremium: 'not-a-number',
      },
      NOW,
    )
    expect(result.ok).toBe(true)
    const r = readJsonl<DemandRecord>(demandLog)[0]!
    expect(r.widthBucket).toBe('unknown')
    expect(r.distanceBucket).toBe('unknown')
    expect(r.durationBucket).toBe('unknown')
    expect(r.previewedPremium).toBeUndefined()
  })

  it('rejects a preview with a missing/invalid marketId (typed result, not thrown)', () => {
    const sink = new TelemetrySink(demandLog, competitionLog)
    const result = sink.ingestPreview({ widthBucket: 'tight' }, NOW)
    expect(result.ok).toBe(false)
    expect(result.logged).toBe(false)
    expect(result.reason).toMatch(/marketId/)
    expect(readJsonl(demandLog)).toHaveLength(0)
  })

  it('logs competing quotes — winners (accepted) AND losers (rejected w/ reason)', () => {
    const sink = new TelemetrySink(demandLog, competitionLog)
    sink.logQuote(quote({ mm: ACCOUNT.address, loadBps: 500 }), true, NOW)
    sink.logQuote(
      quote({ mm: '0x000000000000000000000000000000000000dEaD' as Address, loadBps: 900 }),
      false,
      NOW + 1,
      'bad-signature',
    )
    const recs = readJsonl<CompetitionRecord>(competitionLog)
    expect(recs).toHaveLength(2)
    expect(recs[0]).toMatchObject({
      mm: ACCOUNT.address.toLowerCase(),
      loadBps: 500,
      accepted: true,
    })
    expect(recs[0]!.reason).toBeUndefined()
    expect(recs[1]).toMatchObject({ loadBps: 900, accepted: false, reason: 'bad-signature' })
  })

  it('serializes validUntil as a bigint-safe decimal string', () => {
    const sink = new TelemetrySink(demandLog, competitionLog)
    sink.logQuote(quote({ validUntil: 18_446_744_073_709_551_615n }), true, NOW)
    const r = readJsonl<CompetitionRecord>(competitionLog)[0]!
    expect(r.validUntil).toBe('18446744073709551615')
    expect(BigInt(r.validUntil)).toBe(18_446_744_073_709_551_615n)
  })

  it('is a no-op (never throws) when no sink path is configured', () => {
    const sink = new TelemetrySink(undefined, undefined)
    expect(sink.demandEnabled).toBe(false)
    expect(sink.competitionEnabled).toBe(false)
    expect(sink.logQuoteRequest(MARKET, NOW)).toBe(false)
    expect(sink.logQuote(quote(), true, NOW)).toBe(false)
    expect(sink.ingestPreview({ marketId: MARKET }, NOW)).toEqual({ ok: true, logged: false })
  })
})

describe('engine telemetry wiring (integration)', () => {
  let dir: string
  let demandLog: string
  let competitionLog: string
  let handle: EngineHandle
  let base: string
  let wsUrl: string
  let clock = NOW

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'inflexion-tele-srv-'))
    demandLog = join(dir, 'demand.jsonl')
    competitionLog = join(dir, 'competition.jsonl')
    clock = NOW
    handle = startEngine({
      port: 0, // ephemeral
      chainId: CHAIN_ID,
      verifyingContract: CORE,
      demandLogPath: demandLog,
      competitionLogPath: competitionLog,
      maxValiditySkewS: 60,
      nowSec: () => clock,
    })
    const addr = handle.http.address() as AddressInfo
    base = `http://127.0.0.1:${addr.port}`
    wsUrl = `ws://127.0.0.1:${addr.port}`
  })
  afterEach(async () => {
    await handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('GET /health reports telemetry sink status', async () => {
    const res = await fetch(`${base}/health`)
    const body = (await res.json()) as { telemetry: { demand: boolean; competition: boolean } }
    expect(body.telemetry).toEqual({ demand: true, competition: true })
  })

  it('GET /quote logs the request as latent demand even when no quote exists', async () => {
    const res = await fetch(`${base}/quote?marketId=${MARKET}`)
    expect(res.status).toBe(404) // no live quote yet
    const recs = readJsonl<DemandRecord>(demandLog)
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({
      marketId: MARKET.toLowerCase(),
      source: 'quote-request',
      filled: false,
    })
  })

  it('POST /telemetry/preview accepts a ping (202) and logs it', async () => {
    const res = await fetch(`${base}/telemetry/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        marketId: MARKET,
        widthBucket: 'medium',
        distanceBucket: 'near',
        durationBucket: 'day',
        previewedPremium: '777',
      }),
    })
    expect(res.status).toBe(202)
    const recs = readJsonl<DemandRecord>(demandLog)
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({
      marketId: MARKET.toLowerCase(),
      widthBucket: 'medium',
      distanceBucket: 'near',
      durationBucket: 'day',
      previewedPremium: '777',
      source: 'preview',
      filled: false,
    })
  })

  it('POST /telemetry/preview returns a typed 400 on missing marketId (never crashes)', async () => {
    const res = await fetch(`${base}/telemetry/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ widthBucket: 'tight' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { ok: boolean; reason?: string }
    expect(body.ok).toBe(false)
    expect(body.reason).toMatch(/marketId/)
    expect(readJsonl(demandLog)).toHaveLength(0)
  })

  it('WS logs an accepted (winning) quote to the competition log', async () => {
    const env = await signQuote(PK, quote(), CHAIN_ID, CORE)
    const ack = await sendQuoteWs(wsUrl, env.quote, env.signature)
    expect(ack.type).toBe('ack')
    const recs = readJsonl<CompetitionRecord>(competitionLog)
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({
      marketId: MARKET.toLowerCase(),
      mm: ACCOUNT.address.toLowerCase(),
      loadBps: 500,
      accepted: true,
    })
  })

  it('WS logs a LOSING quote (bad signature) — competition keeps losers', async () => {
    const env = await signQuote(PK, quote(), CHAIN_ID, CORE)
    // Tamper after signing so verifyQuote fails but the mm/marketId are still valid.
    const tampered = { ...env.quote, loadBps: 9999 }
    const rej = await sendQuoteWs(wsUrl, tampered, env.signature)
    expect(rej.type).toBe('rejected')
    expect(rej.reason).toBe('bad-signature')
    const recs = readJsonl<CompetitionRecord>(competitionLog)
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ accepted: false, reason: 'bad-signature', loadBps: 9999 })
  })

  it('WS logs a stale (withdrawn-equivalent) quote as a loser', async () => {
    const stale = quote({ validUntil: BigInt(NOW - 1) }) // already expired vs clock
    const env = await signQuote(PK, stale, CHAIN_ID, CORE)
    const rej = await sendQuoteWs(wsUrl, env.quote, env.signature)
    expect(rej.type).toBe('rejected')
    expect(rej.reason).toBe('stale-or-far-validUntil')
    const recs = readJsonl<CompetitionRecord>(competitionLog)
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ accepted: false, reason: 'stale-or-far-validUntil' })
  })
})

/** Open a WS, send one quote, resolve with the first server reply, then close. */
function sendQuoteWs(
  url: string,
  q: SignedQuote,
  signature: Hex,
): Promise<{ type: string; reason?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('ws timeout'))
    }, 5000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'quote', quote: encodeQuote(q), signature }))
    })
    ws.on('message', (data) => {
      clearTimeout(timer)
      const reply = JSON.parse(data.toString()) as { type: string; reason?: string }
      ws.close()
      resolve(reply)
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}
