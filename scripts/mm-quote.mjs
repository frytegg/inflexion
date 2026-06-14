// Sign + stream a firm MM quote that UNDERCUTS the pool floor, to the hosted engine.
// `sdk.mm.signQuote` enforces I10 (loadBps ≤ maxLoadBps) AND loadBps < the live pool
// load — a quote that does not beat the pool is rejected BEFORE it is signed. The
// quotePrice is re-read from the on-chain oracle each tick, so it stays inside the
// 1% price band (I9) over a multi-minute demo. Re-issues every 5s (30s TTL).
//
// Run (from repo root):
//   MARKET_ID=0xb8bbd684f213d5833886ade7b531a6949d85522249881a2b5d46a5cc76e439c2 \
//   MM_PRIVATE_KEY=0x… LOAD_BPS=1000 \
//   node scripts/mm-quote.mjs
import {
  createInflexionSdk,
  encodeQuote,
  CollateralModel,
  core,
  tokens,
  oracleManagerAbi,
} from '@inflexion/sdk'

const MARKET_ID = process.env.MARKET_ID
const PK = process.env.MM_PRIVATE_KEY
const ENGINE = (process.env.ENGINE_HTTP ?? 'https://inflexion-backend.onrender.com/engine').replace(
  /\/+$/,
  '',
)
const LOAD_BPS = Number(process.env.LOAD_BPS ?? 1000)
const RPC = process.env.RPC_URL ?? 'https://arbitrum-sepolia.publicnode.com'
if (MARKET_ID === undefined || PK === undefined)
  throw new Error('MARKET_ID and MM_PRIVATE_KEY required')

const sdk = createInflexionSdk({ rpcUrl: RPC, privateKey: PK, chainId: 421614 })
const mm = sdk.walletClient.account.address
let nonce = 0n

async function quotePrice() {
  return await sdk.publicClient.readContract({
    address: core.oracleManager,
    abi: oracleManagerAbi,
    functionName: 'getPrice',
    args: [tokens.demoWeth],
  })
}

function buildQuote(price) {
  const now = BigInt(Math.floor(Date.now() / 1000))
  return {
    mm,
    marketId: MARKET_ID,
    loadBps: LOAD_BPS,
    minMaxILRatioBps: 0,
    maxMaxILRatioBps: 10_000,
    quotePrice: price,
    priceBandBps: 100,
    model: CollateralModel.FULL,
    partialRatioBps: 0,
    maxNotionalV0: (1n << 128n) - 1n,
    validUntil: now + 30n,
    quoteId: `0x${'00'.repeat(31)}01`,
    nonce: nonce++,
  }
}

async function post() {
  try {
    const price = await quotePrice()
    const r = await sdk.mm.signQuote(PK, buildQuote(price)) // asserts I10 + below-pool
    const res = await fetch(`${ENGINE}/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        quote: encodeQuote(r.envelope.quote),
        signature: r.envelope.signature,
      }),
    })
    console.log(
      `[mm] loadBps=${LOAD_BPS} < pool ${r.poolLoadBps ?? '?'}bps (undercut=${r.belowPoolChecked}) price=${price} → ${res.status} ${(await res.text()).slice(0, 120)}`,
    )
  } catch (e) {
    console.error('[mm]', e instanceof Error ? e.message : e)
  }
}

console.log(
  `[mm] streaming undercut quotes for ${MARKET_ID} @ ${LOAD_BPS}bps as ${mm} → ${ENGINE}/quote`,
)
await post()
setInterval(post, 5000)
