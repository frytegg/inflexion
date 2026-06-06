import type { ReactNode } from 'react'
import { MarketingHeader } from '@/components/marketing-header'

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-canvas">
      <MarketingHeader />
      <main>{children}</main>
    </div>
  )
}
