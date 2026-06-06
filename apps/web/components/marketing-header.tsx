import Link from 'next/link'
import { Logo } from './logo'

export function MarketingHeader() {
  return (
    <header className="flex items-center justify-between border-b border-line-subtle px-6 py-4">
      <Logo />
      <nav className="flex items-center gap-6 text-body-sm text-fg-secondary">
        <Link href="/markets" className="transition-colors duration-fast hover:text-fg">
          Markets
        </Link>
        <Link href="/data" className="transition-colors duration-fast hover:text-fg">
          Data
        </Link>
        <Link
          href="/protect"
          className="rounded-md bg-accent px-4 py-2 font-medium text-accent-fg transition-colors duration-fast hover:bg-accent-600"
        >
          Launch app →
        </Link>
      </nav>
    </header>
  )
}
