'use client'

// The one hook that wires wagmi's clients into @inflexion/sdk: wagmi publicClient
// for reads, walletClient for writes (undefined until connected → writes degrade
// to a clear error). Addresses load from the registry inside the SDK.
import { useMemo } from 'react'
import { usePublicClient, useWalletClient, useAccount } from 'wagmi'
import type { Hex, PublicClient, WalletClient } from 'viem'
import { createInflexionSdk, type InflexionSdk } from '@inflexion/sdk'

const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL
// Public REST API base (the hosted backend). Wires the DataClient history surfaces
// (NAV history, etc.); absent ⇒ those surfaces degrade to typed pending.
const API_URL = process.env.NEXT_PUBLIC_API_URL

// Arbitrum Sepolia's base fee fluctuates, and injected wallets (MetaMask) frequently
// suggest a maxFeePerGas BELOW it ("the fee cap cannot be lower than the block base
// fee"), which blocks every write. viem delegates fee estimation to the wallet for
// injected accounts, so we compute explicit EIP-1559 fees with generous L2 headroom
// and inject them into every sendTransaction — the wallet then never under-bids.
async function eip1559Fees(
  pub: PublicClient,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  let base: bigint
  try {
    const block = await pub.getBlock({ blockTag: 'latest' })
    base = block.baseFeePerGas ?? (await pub.getGasPrice())
  } catch {
    base = await pub.getGasPrice()
  }
  const tip = 10_000_000n // 0.01 gwei priority — negligible on L2, keeps the tx well-formed
  const bumped = base * 3n + tip // 3× base-fee headroom for swings
  const floor = 100_000_000n // 0.1 gwei floor — comfortably above Sepolia base fees
  return { maxFeePerGas: bumped > floor ? bumped : floor, maxPriorityFeePerGas: tip }
}

// Wrap the wallet so every sendTransaction carries explicit fees. The Proxy transparently
// delegates account/chain/every other property; only sendTransaction is augmented.
function withFeeBumping(wallet: WalletClient, pub: PublicClient): WalletClient {
  return new Proxy(wallet, {
    get(target, prop, receiver) {
      if (prop !== 'sendTransaction') return Reflect.get(target, prop, receiver)
      return async (args: Record<string, unknown>): Promise<Hex> => {
        const fees = await eip1559Fees(pub)
        const send = target.sendTransaction.bind(target) as (a: unknown) => Promise<Hex>
        return send({ ...args, ...fees })
      }
    },
  }) as WalletClient
}

export function useInflexionSdk(): InflexionSdk {
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()
  const { address } = useAccount()

  return useMemo(() => {
    const pub = publicClient as unknown as PublicClient | undefined
    const wallet =
      walletClient && pub
        ? withFeeBumping(walletClient as unknown as WalletClient, pub)
        : (walletClient as unknown as WalletClient | undefined)
    return createInflexionSdk({
      // wagmi clients are viem clients; cast over the generic-param mismatch.
      ...(pub ? { publicClient: pub } : {}),
      ...(wallet ? { walletClient: wallet } : {}),
      chainId: 421614,
      ...(ENGINE_URL ? { engineBaseUrl: ENGINE_URL } : {}),
      ...(API_URL ? { apiBaseUrl: API_URL } : {}),
      ...(typeof fetch !== 'undefined' ? { fetchImpl: fetch } : {}),
    })
    // address is the meaningful identity of walletClient; re-memo on connect/switch.
  }, [publicClient, walletClient, address])
}
