import Link from 'next/link'

/** The Inflexion wordmark — display face + the teal inflection dot. */
export function Logo({ href = '/' }: { href?: string }) {
  return (
    <Link
      href={href}
      className="font-display text-h3 font-bold tracking-tight text-fg transition-colors duration-fast hover:text-fg"
    >
      Inflexion<span className="text-accent">.</span>
    </Link>
  )
}
