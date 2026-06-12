import Link from 'next/link'

const DOORS: Array<{
  href: string
  role: string
  title: string
  body: string
  stat: string
  cta: string
  caution?: boolean
}> = [
  {
    href: '/protect',
    role: 'LP',
    title: 'Protect',
    body: 'Hedge the in-range IL of your Uniswap v3 position.',
    stat: 'premium ≈ 0.5–2.5% of MaxIL',
    cta: 'Protect →',
  },
  {
    href: '/earn',
    role: 'Depositor',
    title: 'Earn',
    body: 'Underwrite IL through the dual-tranche vault.',
    stat: 'senior P(loss)=0 · junior high-APY',
    cta: 'Earn →',
    caution: true,
  },
  {
    href: '/underwrite',
    role: 'Market maker',
    title: 'Underwrite',
    body: 'Post firm quotes, beat the pool, lock your own collateral.',
    stat: 'load to beat: live',
    cta: 'Underwrite →',
  },
]

export function Doors() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16 md:py-24">
      <p className="text-label uppercase text-accent-400">What you do</p>
      <h2 className="mt-3 font-display text-display-lg font-bold text-fg">Three doors.</h2>
      <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
        {DOORS.map((d) => (
          <Link
            key={d.href}
            href={d.href}
            className="group flex h-full flex-col rounded-lg bg-raised p-6 transition-colors duration-base hover:bg-overlay"
          >
            <div className="text-label uppercase text-fg-tertiary">{d.role}</div>
            <h3 className="mt-2 font-display text-h2 font-bold text-fg">{d.title}</h3>
            <p className="mt-2 text-body text-fg-secondary">{d.body}</p>
            <div className="num mt-4 text-mono-sm text-accent-300">{d.stat}</div>
            {d.caution ? (
              <div className="mt-3 text-body-sm text-warn-400">△ capital not guaranteed</div>
            ) : null}
            <div className="mt-auto pt-6 text-body-sm font-medium text-fg transition-colors duration-fast group-hover:text-accent-400">
              {d.cta}
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}
