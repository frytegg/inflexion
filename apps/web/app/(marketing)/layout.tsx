import type { ReactNode } from 'react'
import {
  StaggeredMenu,
  type StaggeredMenuItem,
  type StaggeredMenuSocialItem,
} from '@/components/menu/staggered-menu'
import { Footer } from '@/components/footer'

const MENU_ITEMS: StaggeredMenuItem[] = [
  { label: 'Home', ariaLabel: 'Home', link: '/' },
  { label: 'Protect', ariaLabel: 'Protect a position', link: '/protect' },
  { label: 'Earn', ariaLabel: 'Earn — deposit into the vault', link: '/earn' },
  { label: 'Underwrite', ariaLabel: 'Underwrite as a market maker', link: '/underwrite' },
  { label: 'Markets', ariaLabel: 'View markets', link: '/markets' },
  { label: 'Data', ariaLabel: 'The data moat', link: '/data' },
]

const SOCIALS: StaggeredMenuSocialItem[] = [
  { label: 'Twitter', link: 'https://twitter.com' },
  { label: 'GitHub', link: 'https://github.com/frytegg/inflexion' },
]

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col bg-canvas">
      <StaggeredMenu
        isFixed
        position="right"
        items={MENU_ITEMS}
        socialItems={SOCIALS}
        displaySocials
        colors={['#0B7D70', '#14B8A6']}
        accentColor="#14B8A6"
        menuButtonColor="#F3F5F7"
        openMenuButtonColor="#F3F5F7"
        logoUrl="/inflexion-mark.svg"
      />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  )
}
