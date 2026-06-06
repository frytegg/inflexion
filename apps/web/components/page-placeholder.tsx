/** Scaffold placeholder — real page bodies are built after wireframe approval. */
export function PagePlaceholder({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mx-auto max-w-3xl px-6 py-24">
      <p className="text-label uppercase text-accent-400">Inflexion · scaffold</p>
      <h1 className="mt-3 font-display text-display-lg font-bold text-fg">{title}</h1>
      <p className="mt-4 text-body-lg text-fg-secondary">{subtitle}</p>
      <p className="mt-8 rounded-lg border border-line bg-raised px-4 py-3 text-body-sm text-fg-tertiary">
        Pending wireframe approval — page not built yet. Design tokens locked in{' '}
        <code className="font-mono text-accent-300">DESIGN_TOKENS.md</code>.
      </p>
    </div>
  )
}
