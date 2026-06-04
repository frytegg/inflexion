/**
 * Engine entrypoint — reads config from env and starts the thin Path-B relayer.
 *
 *   PORT                 default 8787
 *   CHAIN_ID             default 421614 (Arbitrum Sepolia)
 *   VERIFYING_CONTRACT   InflexionCore address (required; default = Sepolia deploy)
 *   QUOTE_LOG            append-only JSONL path (optional)
 */
import { type Address } from 'viem'
import { startEngine } from './server.js'

const PORT = Number(process.env['PORT'] ?? 8787)
const CHAIN_ID = Number(process.env['CHAIN_ID'] ?? 421614)
const VERIFYING_CONTRACT = (process.env['VERIFYING_CONTRACT'] ??
  '0x15b74EfcAB40A08281C0Cea972BeE0bbA1a9A96d') as Address
const QUOTE_LOG = process.env['QUOTE_LOG']

const handle = startEngine({
  port: PORT,
  chainId: CHAIN_ID,
  verifyingContract: VERIFYING_CONTRACT,
  ...(QUOTE_LOG !== undefined ? { logPath: QUOTE_LOG } : {}),
})

// eslint-disable-next-line no-console
console.log(
  `[inflexion-engine] Path-B relayer on :${PORT} (chainId=${CHAIN_ID}, core=${VERIFYING_CONTRACT})\n` +
    `  WS    ws://localhost:${PORT}      stream {type:'quote', quote, signature}\n` +
    `  GET   /quote?marketId=0x..        cheapest live quote for a market\n` +
    `  GET   /health`,
)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void handle.close().then(() => process.exit(0))
  })
}
