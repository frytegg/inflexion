import { Card } from '@/components/ui/card'

// The two-never-merged claims — the bridge from "how it works" to "what you do".
// Visually distinct (teal/positive vs amber/caution); never blended.
export function Guarantee() {
  return (
    <section className="border-y border-line-subtle bg-base">
      <div className="mx-auto max-w-6xl px-6 py-16 md:py-24">
        <p className="text-label uppercase text-accent-400">The guarantee</p>
        <h2 className="mt-3 font-display text-display-lg font-bold text-fg">
          Two things, never confused.
        </h2>
        <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-2">
          <Card variant="dots" className="border-accent-700/60">
            <div className="flex items-center gap-2 text-accent-400">
              <span className="text-h3 leading-none">✓</span>
              <span className="text-label uppercase">LPs are always paid</span>
            </div>
            <p className="mt-3 text-body text-fg-secondary">
              No bad debt in FULL mode. Your payout never exceeds the collateral, which equals{' '}
              <span className="num text-fg">MaxIL</span> — enforced in code (invariant I1).
            </p>
          </Card>
          <Card variant="dots" className="border-warn-500/40" dotClassName="bg-warn-400">
            <div className="flex items-center gap-2 text-warn-400">
              <span className="text-h3 leading-none">⚠</span>
              <span className="text-label uppercase">Capital is not guaranteed</span>
            </div>
            <p className="mt-3 text-body text-fg-secondary">
              Depositors and market makers absorb crash losses up to{' '}
              <span className="num text-fg">MaxIL</span> per position. Junior is first-loss. This is
              real underwriting risk.
            </p>
          </Card>
        </div>
      </div>
    </section>
  )
}
