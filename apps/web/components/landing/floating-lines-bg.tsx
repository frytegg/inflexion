'use client'

import dynamic from 'next/dynamic'
import { useState } from 'react'
import { motion } from 'framer-motion'

// FloatingLines uses WebGL (three.js) — load it client-only.
const FloatingLines = dynamic(() => import('@/components/backgrounds/floating-lines'), {
  ssr: false,
})

/**
 * Ambient blue line field behind the hero. Non-interactive (no pointer, no parallax).
 * It mounts (and initializes WebGL) immediately but stays invisible until the first
 * frame is drawn — then it fades in gently (easeInOut) while the waves drift, and
 * signals `onReady` so the hero title can animate at the SAME moment (in sync, and
 * with no WebGL-init jank since init is already done).
 */
export function FloatingLinesBg({ onReady }: { onReady?: () => void }) {
  const [ready, setReady] = useState(false)

  return (
    <motion.div
      className="pointer-events-none absolute inset-0 z-0 select-none"
      aria-hidden="true"
      initial={{ opacity: 0 }}
      animate={{ opacity: ready ? 1 : 0 }}
      transition={{ duration: 2.4, ease: 'easeInOut' }}
    >
      <FloatingLines
        interactive={false}
        parallax={false}
        animationSpeed={0.6}
        linesGradient={['#1D4ED8', '#3B82F6', '#60A5FA']}
        opacity={0.35}
        onReady={() => {
          setReady(true)
          onReady?.()
        }}
      />
    </motion.div>
  )
}
