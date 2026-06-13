'use client'

import { type ReactNode, useState } from 'react'
import { MotionConfig } from 'framer-motion'
import { WagmiProvider } from 'wagmi'
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@rainbow-me/rainbowkit/styles.css'
import { wagmiConfig } from '@/lib/wagmi'

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          // Force English — RainbowKit otherwise auto-detects the browser locale
          // (e.g. renders "Se connecter" on a French browser).
          locale="en-US"
          theme={darkTheme({
            accentColor: '#14B8A6',
            accentColorForeground: '#06231F',
            borderRadius: 'small',
            fontStack: 'system',
          })}
        >
          <MotionConfig reducedMotion="user">{children}</MotionConfig>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
