#!/usr/bin/env node
/**
 * @inflexion/api server entrypoint. Wires env → deps → the node:http app.
 *
 * Env:
 *   PORT                  listen port (default 8088)
 *   SUBGRAPH_URL          deployed subgraph GraphQL endpoint (absent ⇒ surfaces pending)
 *   ARBITRUM_SEPOLIA_RPC  RPC for the ONE live surface (absent ⇒ live endpoints pending)
 *   SEPOLIA_RPC           fallback RPC alias
 *   DEMAND_LOG            engine Signal-4 latent-demand JSONL (read-only)
 *   COMPETITION_LOG       engine Signal-2 quote-competition JSONL (read-only)
 *
 * No wallet, no signer — this is a read-only public facade. Every surface degrades
 * gracefully when its backing (subgraph / RPC / telemetry sink) is absent.
 */
import { createServer } from 'node:http'
import { buildDeps } from './index.js'
import { createApp } from './app.js'

const PORT = Number(process.env['PORT'] ?? '8088')

const SUBGRAPH_URL = process.env['SUBGRAPH_URL']
const RPC_URL = process.env['ARBITRUM_SEPOLIA_RPC'] ?? process.env['SEPOLIA_RPC']
const DEMAND_LOG = process.env['DEMAND_LOG']
const COMPETITION_LOG = process.env['COMPETITION_LOG']

const deps = buildDeps({
  ...(SUBGRAPH_URL !== undefined ? { subgraphUrl: SUBGRAPH_URL } : {}),
  ...(RPC_URL !== undefined ? { rpcUrl: RPC_URL } : {}),
  ...(DEMAND_LOG !== undefined ? { demandLogPath: DEMAND_LOG } : {}),
  ...(COMPETITION_LOG !== undefined ? { competitionLogPath: COMPETITION_LOG } : {}),
})

const server = createServer(createApp(deps))
server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[@inflexion/api] listening on :${PORT} ` +
      `(subgraph=${deps.subgraph.configured} live=${deps.data !== undefined} ` +
      `telemetry.demand=${deps.telemetry.demandEnabled} telemetry.competition=${deps.telemetry.competitionEnabled})`,
  )
})
