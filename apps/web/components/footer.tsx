import Link from 'next/link'
import { Logo } from './logo'

export function Footer() {
  return (
    <footer className="border-t border-line-subtle px-6 py-10">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 md:flex-row md:items-start md:justify-between">
        <div>
          <Logo />
          <p className="mt-3 max-w-sm text-body-sm text-fg-tertiary">
            In-range impermanent-loss hedging on Arbitrum — a collateralized, capped, no-bad-debt
            market.
          </p>
        </div>
        <nav className="flex flex-wrap gap-x-8 gap-y-2 text-body-sm text-fg-secondary">
          <Link href="/protect" className="transition-colors duration-fast hover:text-fg">
            Protect
          </Link>
          <Link href="/earn" className="transition-colors duration-fast hover:text-fg">
            Earn
          </Link>
          <Link href="/underwrite" className="transition-colors duration-fast hover:text-fg">
            Underwrite
          </Link>
          <Link href="/markets" className="transition-colors duration-fast hover:text-fg">
            Markets
          </Link>
          <Link href="/data" className="transition-colors duration-fast hover:text-fg">
            Data
          </Link>
        </nav>
      </div>
      <div className="mx-auto mt-8 max-w-6xl border-t border-line-subtle pt-6 text-body-sm text-fg-tertiary">
        <span className="text-fg-secondary">Arbitrum Sepolia.</span> Capital is not guaranteed for
        depositors &amp; market makers. The no-bad-debt guarantee holds under FULL collateralization
        + solvent USDC + oracle/settlement liveness.
      </div>
    </footer>
  )
}
