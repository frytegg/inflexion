import type { ReactNode } from 'react'
import { AppHeader } from '@/components/app-header'

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-canvas">
      <AppHeader />
      <main>{children}</main>
    </div>
  )
}
