import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { http } from 'wagmi'
import { arbitrumSepolia } from 'wagmi/chains'

// The only network the live deployment targets (chainId 421614).
export const wagmiConfig = getDefaultConfig({
  appName: 'Inflexion',
  // A real WalletConnect project id is needed at runtime; a placeholder keeps the
  // build green when the env var is unset (CI / local without secrets).
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? 'inflexion-dev-placeholder',
  chains: [arbitrumSepolia],
  transports: {
    [arbitrumSepolia.id]: http(process.env.NEXT_PUBLIC_RPC_URL),
  },
  ssr: true,
})
