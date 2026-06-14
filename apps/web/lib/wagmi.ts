import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { fallback, http } from 'viem'
import { arbitrumSepolia } from 'wagmi/chains'

// The only network the live deployment targets: Arbitrum Sepolia (chainId 421614).
//
// RPC: reads (oracle / σ_ref / load surface / positions) are multicall-heavy, so we
// use a RANKED FALLBACK over several CORS-enabled Arbitrum Sepolia endpoints — a
// throttle on one rolls over to the next and the fastest is preferred.
//
// NEXT_PUBLIC_RPC_URL is honored as an additional endpoint ONLY when it targets
// Sepolia. We explicitly reject a *mainnet* override: a wrong-chain RPC (e.g. an
// arb-mainnet Alchemy URL) would otherwise be ranked in and silently fail every
// read against the Sepolia contracts ("oracle degraded", no eligible positions).
const SEPOLIA_RPCS = [
  'https://arbitrum-sepolia.publicnode.com',
  'https://arbitrum-sepolia.drpc.org',
  'https://sepolia-rollup.arbitrum.io/rpc',
]
const envRpc = process.env.NEXT_PUBLIC_RPC_URL
const rpcUrls = envRpc && !/mainnet/i.test(envRpc) ? [envRpc, ...SEPOLIA_RPCS] : SEPOLIA_RPCS

export const wagmiConfig = getDefaultConfig({
  appName: 'Inflexion',
  // A real WalletConnect project id is needed at runtime; a placeholder keeps the
  // build green when the env var is unset (CI / local without secrets).
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? 'inflexion-dev-placeholder',
  chains: [arbitrumSepolia],
  transports: {
    [arbitrumSepolia.id]: fallback(
      rpcUrls.map((url) => http(url)),
      { rank: true },
    ),
  },
  ssr: true,
})
