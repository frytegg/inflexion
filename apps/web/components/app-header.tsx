'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { Logo } from './logo'
import { cn } from '@/lib/utils'

const NAV = [
  { href: '/protect', label: 'Protect' },
  { href: '/earn', label: 'Earn' },
  { href: '/underwrite', label: 'Underwrite' },
  { href: '/markets', label: 'Markets' },
  { href: '/data', label: 'Data' },
  { href: '/dashboard', label: 'Dashboard' },
]

export function AppHeader() {
  const pathname = usePathname()
  return (
    <header className="flex items-center justify-between gap-6 border-b border-line-subtle px-6 py-4">
      <div className="flex items-center gap-8">
        <Logo href="/markets" />
        <nav className="hidden items-center gap-5 text-body-sm md:flex">
          {NAV.map((item) => {
            const active = pathname === item.href
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'transition-colors duration-fast hover:text-fg',
                  active ? 'text-fg' : 'text-fg-tertiary',
                )}
              >
                {item.label}
              </Link>
            )
          })}
        </nav>
      </div>
      <ConnectButton showBalance={false} chainStatus="icon" accountStatus="address" />
    </header>
  )
}
