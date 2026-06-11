'use client'

import dynamic from 'next/dynamic'

// FloatingLines uses WebGL (three.js) — load it client-only.
const FloatingLines = dynamic(() => import('@/components/backgrounds/floating-lines'), {
  ssr: false,
})

/** Ambient blue line field behind the hero — non-interactive (no pointer, no parallax). */
export function FloatingLinesBg() {
  return (
    <div className="pointer-events-none absolute inset-0 z-0 select-none" aria-hidden="true">
      <FloatingLines
        interactive={false}
        parallax={false}
        linesGradient={['#1D4ED8', '#3B82F6', '#60A5FA']}
        opacity={0.35}
      />
    </div>
  )
}
