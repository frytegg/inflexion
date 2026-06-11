import Link from 'next/link'

/** The Inflexion lockup — the brand mark + the wordmark (display face + teal inflection dot). */
export function Logo({ href = '/' }: { href?: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 font-display text-h3 font-bold tracking-tight text-fg transition-colors duration-fast hover:text-fg"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo_inflexion.svg" alt="" aria-hidden="true" className="h-7 w-7 shrink-0" />
      <span>
        Inflexion<span className="text-accent">.</span>
      </span>
    </Link>
  )
}
