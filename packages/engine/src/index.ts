/**
 * Engine entrypoint — reads config from env and starts the thin Path-B relayer.
 *
 *   PORT                 default 8787
 *   CHAIN_ID             default 421614 (Arbitrum Sepolia)
 *   VERIFYING_CONTRACT   InflexionCore address (default = registry core.inflexionCore)
 *   QUOTE_LOG            append-only JSONL path for accepted quotes (optional)
 *   DEMAND_LOG           append-only JSONL path for Signal-4 latent demand
 *                        (/quote requests + SDK previewPremium pings) (optional)
 *   COMPETITION_LOG      append-only JSONL path for Signal-2 quote competition
 *                        (every WS quote, winners + losers) (optional)
 *
 * DEMAND_LOG / COMPETITION_LOG are the DAY-ONE telemetry sinks: these two signals
 * are unreconstructable retroactively (unfilled / previewed interest never reaches
 * the chain). Set them from the first deploy. See docs/ENGINE_TELEMETRY.md.
 */
import { type Address } from 'viem'
import { startEngine } from './server.js'
import { DEFAULT_VERIFYING_CONTRACT } from './addresses.js'

const PORT = Number(process.env['ENGINE_PORT'] ?? process.env['PORT'] ?? 8787)
const CHAIN_ID = Number(process.env['CHAIN_ID'] ?? 421614)
const VERIFYING_CONTRACT = (process.env['VERIFYING_CONTRACT'] ??
  DEFAULT_VERIFYING_CONTRACT) as Address
const QUOTE_LOG = process.env['QUOTE_LOG']
const DEMAND_LOG = process.env['DEMAND_LOG']
const COMPETITION_LOG = process.env['COMPETITION_LOG']

const handle = startEngine({
  port: PORT,
  chainId: CHAIN_ID,
  verifyingContract: VERIFYING_CONTRACT,
  ...(QUOTE_LOG !== undefined ? { logPath: QUOTE_LOG } : {}),
  ...(DEMAND_LOG !== undefined ? { demandLogPath: DEMAND_LOG } : {}),
  ...(COMPETITION_LOG !== undefined ? { competitionLogPath: COMPETITION_LOG } : {}),
})

// eslint-disable-next-line no-console
console.log(
  `[inflexion-engine] Path-B relayer on :${PORT} (chainId=${CHAIN_ID}, core=${VERIFYING_CONTRACT})\n` +
    `  WS    ws://localhost:${PORT}      stream {type:'quote', quote, signature}\n` +
    `  GET   /quote?marketId=0x..        cheapest live quote for a market\n` +
    `  POST  /telemetry/preview          SDK previewPremium ping (Signal-4 demand)\n` +
    `  GET   /health`,
)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void handle.close().then(() => process.exit(0))
  })
}
