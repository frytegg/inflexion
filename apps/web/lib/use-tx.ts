'use client'

// One write-flow hook for the whole app. A write fn returns either a txHash (Hex,
// from LpClient/MmClient) or a WriteResult-like object (DepositorClient). This
// normalizes both, waits for the receipt, and exposes status for buttons/toasts.
import { useCallback, useState } from 'react'
import { usePublicClient } from 'wagmi'
import type { Hex } from 'viem'

export type TxStatus = 'idle' | 'signing' | 'pending' | 'success' | 'error'

interface WriteResultLike {
  status: string // 'sent' | 'deferred-no-wallet' | 'error'
  txHash?: Hex
  detail?: string
}

function isWriteResult(v: unknown): v is WriteResultLike {
  return typeof v === 'object' && v !== null && 'status' in v
}

export interface UseTxReturn {
  run: (fn: () => Promise<Hex | WriteResultLike>) => Promise<Hex | undefined>
  status: TxStatus
  hash: Hex | undefined
  error: string | undefined
  reset: () => void
  isBusy: boolean
}

export function useTx(): UseTxReturn {
  const publicClient = usePublicClient()
  const [status, setStatus] = useState<TxStatus>('idle')
  const [hash, setHash] = useState<Hex | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const reset = useCallback(() => {
    setStatus('idle')
    setHash(undefined)
    setError(undefined)
  }, [])

  const run = useCallback(
    async (fn: () => Promise<Hex | WriteResultLike>): Promise<Hex | undefined> => {
      setStatus('signing')
      setError(undefined)
      setHash(undefined)
      try {
        const res = await fn()
        let txHash: Hex | undefined
        if (typeof res === 'string') {
          txHash = res as Hex
        } else if (isWriteResult(res)) {
          if (res.status === 'error') throw new Error(res.detail ?? 'transaction failed')
          if (res.status === 'deferred-no-wallet') throw new Error('Connect a wallet to sign.')
          txHash = res.txHash
        }
        if (!txHash) throw new Error('No transaction hash returned.')
        setHash(txHash)
        setStatus('pending')
        await publicClient?.waitForTransactionReceipt({ hash: txHash })
        setStatus('success')
        return txHash
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // Trim viem's verbose multi-line revert dumps to the first line.
        setError(msg.split('\n')[0])
        setStatus('error')
        return undefined
      }
    },
    [publicClient],
  )

  return { run, status, hash, error, reset, isBusy: status === 'signing' || status === 'pending' }
}
