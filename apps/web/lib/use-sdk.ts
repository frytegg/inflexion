'use client'

// The one hook that wires wagmi's clients into @inflexion/sdk: wagmi publicClient
// for reads, walletClient for writes (undefined until connected → writes degrade
// to a clear error). Addresses load from the registry inside the SDK. See
// apps/web/INTEGRATION_MAP.md §1.
import { useMemo } from 'react'
import { usePublicClient, useWalletClient, useAccount } from 'wagmi'
import type { PublicClient, WalletClient } from 'viem'
import { createInflexionSdk, type InflexionSdk } from '@inflexion/sdk'

const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL
// Public REST API base (the hosted backend). Wires the DataClient history surfaces
// (NAV history, etc.); absent ⇒ those surfaces degrade to typed pending.
const API_URL = process.env.NEXT_PUBLIC_API_URL

export function useInflexionSdk(): InflexionSdk {
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()
  const { address } = useAccount()

  return useMemo(
    () =>
      createInflexionSdk({
        // wagmi clients are viem clients; cast over the generic-param mismatch.
        ...(publicClient ? { publicClient: publicClient as unknown as PublicClient } : {}),
        ...(walletClient ? { walletClient: walletClient as unknown as WalletClient } : {}),
        chainId: 421614,
        ...(ENGINE_URL ? { engineBaseUrl: ENGINE_URL } : {}),
        ...(API_URL ? { apiBaseUrl: API_URL } : {}),
        ...(typeof fetch !== 'undefined' ? { fetchImpl: fetch } : {}),
      }),
    // address is the meaningful identity of walletClient; re-memo on connect/switch.
    [publicClient, walletClient, address],
  )
}
