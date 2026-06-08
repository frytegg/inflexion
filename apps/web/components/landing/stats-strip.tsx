// Headline metrics. Quality over tiny absolutes: clearing load + senior APY tease
// the moat; markets is known from the registry. Honest "—" + tooltip until the
// API/subgraph are live (task #30 / #33).
const STATS: Array<{ label: string; value: string; hint: string }> = [
  { label: 'Notional protected', value: '—', hint: 'Live once the API is connected' },
  {
    label: 'Clearing load',
    value: '—',
    hint: 'Realized load over σ_ref — live once the subgraph is indexed',
  },
  { label: 'Senior APY', value: '—', hint: 'Live once the vault is funded' },
  { label: 'Markets', value: '9', hint: 'ETH/USDC · 3 fees × 3 durations' },
]

export function StatsStrip() {
  return (
    <section className="border-y border-line-subtle bg-base">
      <div className="mx-auto grid max-w-6xl grid-cols-2 divide-x divide-line-subtle md:grid-cols-4">
        {STATS.map((s) => (
          <div key={s.label} className="px-6 py-5" title={s.hint}>
            <div className="num text-mono-stat text-fg">{s.value}</div>
            <div className="mt-1 text-label uppercase text-fg-tertiary">{s.label}</div>
          </div>
        ))}
      </div>
    </section>
  )
}
