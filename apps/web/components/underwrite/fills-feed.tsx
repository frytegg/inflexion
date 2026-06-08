'use client'

// Recent fills against an MM, via `mm.watchFills` (coarse on-chain SwapCreated
// poll — attribution is coarse: the event carries `mm` but NOT quoteId/nonce, so
// it cannot be joined to a specific signed quote; precise per-quote attribution
// is the now-live QuoteFilled event, pending the subgraph). Never throws.
import { useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'
import type { FillLog } from '@inflexion/sdk'
import { useInflexionSdk } from '@/lib/use-sdk'
import { fmtUsd, truncHex, truncAddr } from '@/lib/format'
import { Badge, EmptyState, Spinner } from '@/components/ui'

const MAX_ROWS = 20

export function FillsFeed({ mm }: { mm: Address }) {
  const sdk = useInflexionSdk()
  const [fills, setFills] = useState<FillLog[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [started, setStarted] = useState(false)
  const seen = useRef<Set<string>>(new Set())

  useEffect(() => {
    seen.current = new Set()
    setFills([])
    setError(undefined)
    setStarted(false)
    // Walk back a window so the feed isn't empty on first paint.
    let stopFn: (() => void) | undefined
    let cancelled = false
    void (async () => {
      let fromBlock: bigint | undefined
      try {
        const latest = await sdk.publicClient.getBlockNumber()
        // ~last few hours of Arbitrum Sepolia blocks (best-effort lookback).
        fromBlock = latest > 200_000n ? latest - 200_000n : 0n
      } catch {
        fromBlock = undefined
      }
      if (cancelled) return
      const handle = sdk.mm.watchFills(
        mm,
        (fill) => {
          const key = `${fill.txHash}:${fill.swapId.toString()}`
          if (seen.current.has(key)) return
          seen.current.add(key)
          setStarted(true)
          setFills((prev) => [fill, ...prev].slice(0, MAX_ROWS))
        },
        {
          intervalMs: 8_000,
          ...(fromBlock !== undefined ? { fromBlock } : {}),
          onError: (e) => setError(e.message.split('\n')[0]),
        },
      )
      stopFn = handle.stop
      setStarted(true)
    })()
    return () => {
      cancelled = true
      stopFn?.()
    }
  }, [sdk, mm])

  if (error) {
    return (
      <p className="text-body-sm text-fg-tertiary">
        Fill watch degraded: <span className="text-loss">{error}</span> — retrying.
      </p>
    )
  }

  if (fills.length === 0) {
    return started ? (
      <EmptyState
        title="No fills yet"
        desc="Signed quotes that get hit appear here. Attribution is coarse on-chain (SwapCreated has no quoteId/nonce); precise per-quote attribution is pending the subgraph."
      />
    ) : (
      <div className="flex items-center gap-2 text-body-sm text-fg-tertiary">
        <Spinner /> Scanning recent blocks for fills…
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-body-sm">
        <thead>
          <tr className="border-b border-line-subtle text-left text-label uppercase text-fg-tertiary">
            <th className="py-2 pr-4 font-normal">Swap</th>
            <th className="py-2 pr-4 font-normal">LP</th>
            <th className="py-2 pr-4 font-normal text-right">V0</th>
            <th className="py-2 pr-4 font-normal text-right">MaxIL</th>
            <th className="py-2 pr-4 font-normal text-right">Premium</th>
            <th className="py-2 font-normal">Tx</th>
          </tr>
        </thead>
        <tbody>
          {fills.map((f) => (
            <tr key={`${f.txHash}:${f.swapId}`} className="border-b border-line-subtle/60">
              <td className="num py-2 pr-4 text-fg">#{f.swapId.toString()}</td>
              <td className="num py-2 pr-4 text-fg-secondary">{truncAddr(f.lp)}</td>
              <td className="num py-2 pr-4 text-right text-fg">{fmtUsd(f.V0)}</td>
              <td className="num py-2 pr-4 text-right text-warn-400">{fmtUsd(f.maxIL)}</td>
              <td className="num py-2 pr-4 text-right text-accent-400">{fmtUsd(f.premium)}</td>
              <td className="num py-2 text-fg-tertiary">
                <span className="inline-flex items-center gap-2">
                  {truncHex(f.txHash)}
                  <Badge tone="neutral">{f.attribution}</Badge>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-body-sm text-fg-tertiary">
        Attribution is <span className="text-warn-400">coarse</span> — SwapCreated carries no
        quoteId/nonce. Precise per-quote attribution arrives with the subgraph (QuoteFilled).
      </p>
    </div>
  )
}
