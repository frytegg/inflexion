// Combined Inflexion backend — one process, one port.
//   /            -> the public REST API (@inflexion/api)
//   /engine/*    -> the Path-B quote relayer (@inflexion/engine)
//
// Co-locating them means the API reads the SAME telemetry JSONL the engine writes
// (DEMAND_LOG / COMPETITION_LOG on a shared volume), so the off-chain halves of
// Signal 2 (quote competition) and Signal 4 (latent demand) are live alongside the
// subgraph-backed and live-RPC signals.
//
// Env (set in the host platform; see .env.example):
//   PORT                 listen port (Railway injects this; default 8088)
//   CHAIN_ID             default 421614 (Arbitrum Sepolia)
//   VERIFYING_CONTRACT   InflexionCore address (default = registry core.inflexionCore)
//   SUBGRAPH_URL         deployed subgraph GraphQL endpoint (absent -> history pending)
//   ARBITRUM_SEPOLIA_RPC live RPC for the current load-surface (or SEPOLIA_RPC)
//   DEMAND_LOG           Signal-4 latent-demand JSONL (shared volume, e.g. /data/demand.jsonl)
//   COMPETITION_LOG      Signal-2 quote-competition JSONL (shared volume)
//   QUOTE_LOG            accepted-quote JSONL (optional)
import { createServer } from 'node:http'
import { buildDeps, createApp } from '@inflexion/api'
import { createEngineParts } from '@inflexion/engine/server'
import { DEFAULT_VERIFYING_CONTRACT } from '@inflexion/engine/addresses'

const PORT = Number(process.env.PORT ?? 8088)
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 421614)
const VERIFYING_CONTRACT = process.env.VERIFYING_CONTRACT ?? DEFAULT_VERIFYING_CONTRACT
const SUBGRAPH_URL = process.env.SUBGRAPH_URL
const RPC_URL = process.env.ARBITRUM_SEPOLIA_RPC ?? process.env.SEPOLIA_RPC
const DEMAND_LOG = process.env.DEMAND_LOG
const COMPETITION_LOG = process.env.COMPETITION_LOG
const QUOTE_LOG = process.env.QUOTE_LOG

// Path-B relayer parts (handler only — no own port; mounted under /engine).
const engine = createEngineParts({
  port: 0,
  chainId: CHAIN_ID,
  verifyingContract: VERIFYING_CONTRACT,
  ...(QUOTE_LOG !== undefined ? { logPath: QUOTE_LOG } : {}),
  ...(DEMAND_LOG !== undefined ? { demandLogPath: DEMAND_LOG } : {}),
  ...(COMPETITION_LOG !== undefined ? { competitionLogPath: COMPETITION_LOG } : {}),
})

// REST API handler — reads the SAME telemetry paths the engine writes.
const apiHandler = createApp(
  buildDeps({
    ...(SUBGRAPH_URL !== undefined ? { subgraphUrl: SUBGRAPH_URL } : {}),
    ...(RPC_URL !== undefined ? { rpcUrl: RPC_URL } : {}),
    ...(DEMAND_LOG !== undefined ? { demandLogPath: DEMAND_LOG } : {}),
    ...(COMPETITION_LOG !== undefined ? { competitionLogPath: COMPETITION_LOG } : {}),
  }),
)

const ENGINE_PREFIX = '/engine'
const server = createServer((req, res) => {
  // Normalize a trailing slash on the path (keep root "/" + the query string) so a
  // request to /health/ behaves like /health — clients (monitors, browsers) often add one.
  const raw = req.url ?? '/'
  const qIdx = raw.indexOf('?')
  let pathOnly = qIdx === -1 ? raw : raw.slice(0, qIdx)
  const query = qIdx === -1 ? '' : raw.slice(qIdx)
  if (pathOnly.length > 1) pathOnly = pathOnly.replace(/\/+$/, '') || '/'
  req.url = pathOnly + query

  const path = req.url
  if (path === ENGINE_PREFIX || path.startsWith(ENGINE_PREFIX + '/')) {
    // Strip the /engine prefix so the relayer sees its own routes (/quote, /health…).
    req.url = path.slice(ENGINE_PREFIX.length) || '/'
    engine.handler(req, res)
    return
  }
  apiHandler(req, res)
})

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[inflexion-backend] listening on :${PORT}\n` +
      `  API     /            markets, pool, pricing, swaps, data/*, sigma, mm, health\n` +
      `  Engine  /engine/*     GET/POST /engine/quote, POST /engine/telemetry/preview, /engine/health\n` +
      `  subgraph=${SUBGRAPH_URL !== undefined} rpc=${RPC_URL !== undefined} chainId=${CHAIN_ID} core=${VERIFYING_CONTRACT}`,
  )
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)))
}
