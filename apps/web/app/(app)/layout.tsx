import type { ReactNode } from 'react'
import { AppHeader } from '@/components/app-header'
import { GridBackdrop } from '@/components/backgrounds/grid-backdrop'

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <GridBackdrop />
      <AppHeader />
      <main>{children}</main>
    </div>
  )
}
