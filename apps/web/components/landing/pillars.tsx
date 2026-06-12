const PILLARS: Array<{ n: string; title: string; body: string }> = [
  {
    n: '01',
    title: 'On-chain FairValue',
    body: 'An exact closed-form Φ-sum prices every hedge on-chain — no oracle guess, no fitted curve. The fair price is public.',
  },
  {
    n: '02',
    title: 'cvAMM pool',
    body: 'An always-on, signature-free pool quotes off the published FairValue. No matcher, no counterparty to find.',
  },
  {
    n: '03',
    title: 'MM competition',
    body: 'Sophisticated market makers post firm quotes that undercut the pool. The router always gives you the cheaper of the two.',
  },
]

import { Card } from '@/components/ui/card'

export function Pillars() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16 md:py-24">
      <p className="text-label uppercase text-accent-400">How it works</p>
      <h2 className="mt-3 font-display text-display-lg font-bold text-fg">Three pillars.</h2>
      <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
        {PILLARS.map((p) => (
          <Card key={p.n} variant="dots">
            <div className="num text-mono-sm text-accent-400">{p.n}</div>
            <h3 className="mt-3 font-display text-h3 font-medium text-fg">{p.title}</h3>
            <p className="mt-2 text-body text-fg-secondary">{p.body}</p>
          </Card>
        ))}
      </div>
    </section>
  )
}
