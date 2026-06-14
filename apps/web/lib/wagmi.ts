import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { fallback, http } from 'viem'
import { arbitrumSepolia } from 'wagmi/chains'

// The only network the live deployment targets (chainId 421614).
//
// RPC: the public `sepolia-rollup.arbitrum.io` endpoint rate-limits the app's
// multicall bursts (oracle / σ_ref / load surface across every market), which
// surfaces in the UI as "oracle degraded" and hides eligible positions. We use a
// RANKED FALLBACK over several CORS-enabled endpoints so a throttle on one rolls
// over to the next and the fastest is preferred. Set NEXT_PUBLIC_RPC_URL to a
// dedicated provider (e.g. Alchemy) for best results — it's included and ranked
// in alongside the public fallbacks.
const rpcUrls = [
  'https://arbitrum-sepolia.publicnode.com',
  'https://arbitrum-sepolia.drpc.org',
  ...(process.env.NEXT_PUBLIC_RPC_URL ? [process.env.NEXT_PUBLIC_RPC_URL] : []),
]

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
