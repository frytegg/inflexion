import Link from 'next/link'

export function DataTeaser() {
  return (
    <section className="border-t border-line-subtle bg-base">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-16 md:flex-row md:items-center md:justify-between md:py-20">
        <div className="max-w-2xl">
          <p className="text-label uppercase text-accent-400">The data moat</p>
          <h2 className="mt-3 font-display text-display-lg font-bold text-fg">
            The vol-risk premium, on-chain.
          </h2>
          <p className="mt-3 text-body-lg text-fg-secondary">
            The first public view into the microstructure of the DeFi LP volatility-risk premium —
            clearing load over a transparent σ_ref, the pool-vs-MM spread, term structure, and net
            gamma. Free, and it exists nowhere else.
          </p>
        </div>
        <Link
          href="/data"
          className="shrink-0 rounded-lg border border-line-strong px-5 py-3 font-medium text-fg transition-colors duration-fast hover:border-accent-700 hover:text-accent-400"
        >
          Explore the data →
        </Link>
      </div>
    </section>
  )
}
