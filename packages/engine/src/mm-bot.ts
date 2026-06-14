/* eslint-disable no-console */
/**
 * Example market-maker bot — signs a fresh `SignedQuote` on a loop and streams it
 * to the relayer. Demonstrates the firm-quote / short-TTL model: each quote is GTD
 * (`validUntil = now + ttl`) and simply re-issued; the MM "cancels" by not
 * refreshing (and the on-chain oracle band voids stale quotes).
 *
 *   MM_PRIVATE_KEY      the MM's signer (required, 0x-hex)
 *   MARKET_ID           bytes32 market to quote (required)
 *   ENGINE_HTTP         POST quotes here (e.g. https://host/engine) — required for the
 *                       combined hosted backend, which exposes HTTP only (no WS).
 *   ENGINE_WS           WS relayer (default ws://localhost:8787) — used only when
 *                       ENGINE_HTTP is unset (local standalone engine).
 *   CHAIN_ID            default 421614 (Arbitrum Sepolia)
 *   VERIFYING_CONTRACT  InflexionCore (default = registry core.inflexionCore)
 *   QUOTE_PRICE         static oracle price the MM signs against (uint128, default 0).
 *                       Ignored when the live-oracle vars below are set.
 *   RPC_URL             (or ARBITRUM_SEPOLIA_RPC / SEPOLIA_RPC) — read the live oracle
 *   ORACLE_MANAGER      OracleManager address — price each tick so quotePrice never
 *   ORACLE_TOKEN        oracle token (e.g. dWETH) — drifts outside the price band (I9).
 *   LOAD_BPS            spread over FairPremium (default 500 = 5%)
 */
import WebSocket from 'ws'
import { createPublicClient, http, type Address, type Hex } from 'viem'
import { arbitrumSepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { type SignedQuote, CollateralModel, encodeQuote, signQuote } from './quote.js'
import { DEFAULT_VERIFYING_CONTRACT } from './addresses.js'

const TTL_S = 10n
const REISSUE_MS = 5000

const pk = process.env['MM_PRIVATE_KEY'] as Hex | undefined
const marketId = process.env['MARKET_ID'] as Hex | undefined
if (pk === undefined || marketId === undefined) {
  throw new Error('MM_PRIVATE_KEY and MARKET_ID are required')
}
// Narrowed binding: TS doesn't carry the guard's narrowing into the hoisted
// buildSigned() declaration, so capture pk as a definitely-defined Hex here.
const signerKey: Hex = pk
const httpUrl = process.env['ENGINE_HTTP']
const wsUrl = process.env['ENGINE_WS'] ?? 'ws://localhost:8787'
const chainId = Number(process.env['CHAIN_ID'] ?? 421614)
const verifyingContract = (process.env['VERIFYING_CONTRACT'] ??
  DEFAULT_VERIFYING_CONTRACT) as Address
const staticQuotePrice = BigInt(process.env['QUOTE_PRICE'] ?? '0')
const loadBps = Number(process.env['LOAD_BPS'] ?? 500)

// Live-oracle mode: track OracleManager.getPrice(token) each tick so the signed
// quotePrice equals the price the chain re-checks at createSwap — the quote then
// never drifts outside priceBandBps (I9) over a multi-minute demo.
const rpcUrl =
  process.env['RPC_URL'] ?? process.env['ARBITRUM_SEPOLIA_RPC'] ?? process.env['SEPOLIA_RPC']
const oracleManager = process.env['ORACLE_MANAGER'] as Address | undefined
const oracleToken = process.env['ORACLE_TOKEN'] as Address | undefined
const ORACLE_ABI = [
  {
    type: 'function',
    name: 'getPrice',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const
const pub =
  rpcUrl !== undefined && oracleManager !== undefined && oracleToken !== undefined
    ? createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl) })
    : undefined

async function currentQuotePrice(): Promise<bigint> {
  if (pub !== undefined && oracleManager !== undefined && oracleToken !== undefined) {
    try {
      return (await pub.readContract({
        address: oracleManager,
        abi: ORACLE_ABI,
        functionName: 'getPrice',
        args: [oracleToken],
      })) as bigint
    } catch (e) {
      console.error('[mm-bot] oracle read failed, using static QUOTE_PRICE', e)
    }
  }
  return staticQuotePrice
}

const mm = privateKeyToAccount(pk).address
let nonce = 0n

function buildQuote(quotePrice: bigint): SignedQuote {
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  return {
    mm,
    marketId: marketId as Hex,
    loadBps,
    minMaxILRatioBps: 0,
    maxMaxILRatioBps: 10_000,
    quotePrice,
    priceBandBps: 100,
    model: CollateralModel.FULL,
    partialRatioBps: 0,
    maxNotionalV0: (1n << 128n) - 1n,
    validUntil: nowSec + TTL_S,
    quoteId: `0x${'00'.repeat(31)}01`,
    nonce: nonce++,
  }
}

async function buildSigned(): Promise<{
  wire: ReturnType<typeof encodeQuote>
  signature: Hex
  quotePrice: bigint
}> {
  const quotePrice = await currentQuotePrice()
  const env = await signQuote(signerKey, buildQuote(quotePrice), chainId, verifyingContract)
  return { wire: encodeQuote(env.quote), signature: env.signature, quotePrice }
}

if (httpUrl !== undefined) {
  // HTTP POST mode — for the combined hosted backend (HTTP only, no WS).
  const endpoint = `${httpUrl.replace(/\/+$/, '')}/quote`
  console.log(`[mm-bot] POST ${endpoint}; quoting ${marketId} @ ${loadBps}bps as ${mm}`)
  const tick = async (): Promise<void> => {
    try {
      const { wire, signature, quotePrice } = await buildSigned()
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quote: wire, signature }),
      })
      console.log(
        `[mm-bot] ${res.status} price=${quotePrice} <- ${(await res.text()).slice(0, 200)}`,
      )
    } catch (e) {
      console.error('[mm-bot] post error', e)
    }
  }
  void tick()
  setInterval(() => void tick(), REISSUE_MS)
} else {
  // WS mode — local standalone engine (startEngine).
  const ws = new WebSocket(wsUrl)
  ws.on('open', () => {
    console.log(`[mm-bot] connected ${wsUrl}; quoting ${marketId} @ ${loadBps}bps as ${mm}`)
    const tick = async (): Promise<void> => {
      const { wire, signature } = await buildSigned()
      ws.send(JSON.stringify({ type: 'quote', quote: wire, signature }))
    }
    void tick()
    setInterval(() => void tick(), REISSUE_MS)
  })
  ws.on('message', (data) => console.log(`[mm-bot] <- ${data.toString()}`))
  ws.on('error', (err) => console.error('[mm-bot] ws error', err))
}
