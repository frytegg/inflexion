/**
 * Example market-maker bot — signs a fresh `SignedQuote` on a loop and streams it
 * to the relayer over WebSocket. Demonstrates the firm-quote / short-TTL model:
 * each quote is GTD (`validUntil = now + ttl`) and simply re-issued; the MM
 * "cancels" by not refreshing (and the on-chain oracle band voids stale quotes).
 *
 *   MM_PRIVATE_KEY      the MM's signer (required, 0x-hex)
 *   MARKET_ID           bytes32 market to quote (required)
 *   ENGINE_WS           default ws://localhost:8787
 *   CHAIN_ID            default 421614 (Arbitrum Sepolia)
 *   VERIFYING_CONTRACT  InflexionCore (default = registry core.inflexionCore)
 *   QUOTE_PRICE         oracle price the MM signs against (uint128, default 0)
 *   LOAD_BPS            spread over FairPremium (default 500 = 5%)
 */
import WebSocket from 'ws'
import { type Address, type Hex } from 'viem'
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
const wsUrl = process.env['ENGINE_WS'] ?? 'ws://localhost:8787'
const chainId = Number(process.env['CHAIN_ID'] ?? 421614)
const verifyingContract = (process.env['VERIFYING_CONTRACT'] ??
  DEFAULT_VERIFYING_CONTRACT) as Address
const quotePrice = BigInt(process.env['QUOTE_PRICE'] ?? '0')
const loadBps = Number(process.env['LOAD_BPS'] ?? 500)

const mm = privateKeyToAccount(pk).address
let nonce = 0n

function buildQuote(): SignedQuote {
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  const q: SignedQuote = {
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
  return q
}

const ws = new WebSocket(wsUrl)
ws.on('open', () => {
  // eslint-disable-next-line no-console
  console.log(`[mm-bot] connected ${wsUrl}; quoting ${marketId} @ ${loadBps}bps as ${mm}`)
  const tick = async (): Promise<void> => {
    const env = await signQuote(pk, buildQuote(), chainId, verifyingContract)
    ws.send(
      JSON.stringify({ type: 'quote', quote: encodeQuote(env.quote), signature: env.signature }),
    )
  }
  void tick()
  setInterval(() => void tick(), REISSUE_MS)
})
ws.on('message', (data) => {
  // eslint-disable-next-line no-console
  console.log(`[mm-bot] <- ${data.toString()}`)
})
ws.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[mm-bot] ws error', err)
})
