import Link from 'next/link'
import { PayoffChart } from '@/components/charts/payoff-chart'

// Illustrative ETH/USDC geometry (±15% range). The real position drives the chart on /protect.
const DEMO_GEOMETRY = { pa: 2550, p0: 3000, pb: 3450 }

export function Hero() {
  return (
    <section className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-10 px-6 py-16 md:grid-cols-[55fr_45fr] md:py-24">
      <div>
        <p className="text-label uppercase text-accent-400">On-chain · Arbitrum</p>
        <h1 className="mt-4 font-display text-display-xl font-bold tracking-tight text-fg md:text-display-2xl">
          Hedge in-range
          <br />
          impermanent loss.
        </h1>
        <p className="mt-5 max-w-xl text-body-lg text-fg-secondary">
          Pay a fixed premium, transfer the in-range IL risk of your Uniswap v3 position. Paid your
          realized IL at expiry —{' '}
          <span className="text-fg">
            capped at <span className="num text-warn-400">MaxIL</span>
          </span>
          .
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href="/protect"
            className="rounded-lg bg-accent px-5 py-3 font-medium text-accent-fg shadow-glow transition-colors duration-fast hover:bg-accent-600"
          >
            Protect a position
          </Link>
          <Link
            href="/data"
            className="rounded-lg border border-line-strong px-5 py-3 font-medium text-fg transition-colors duration-fast hover:border-fg-tertiary"
          >
            See the data
          </Link>
        </div>
        <p className="mt-6 text-body-sm text-fg-tertiary">
          No bad debt under FULL · firm on-chain pricing · no last-look.
        </p>
      </div>

      <figure className="rounded-xl border border-line bg-inset p-4">
        <PayoffChart geometry={DEMO_GEOMETRY} className="w-full" />
        <figcaption className="mt-1 px-2 text-body-sm text-fg-tertiary">
          Covered while your position stays in range; the payout is capped at MaxIL beyond it.
        </figcaption>
      </figure>
    </section>
  )
}
