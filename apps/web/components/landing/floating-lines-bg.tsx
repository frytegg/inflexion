'use client'

import dynamic from 'next/dynamic'
import { motion } from 'framer-motion'

// FloatingLines uses WebGL (three.js) — load it client-only.
const FloatingLines = dynamic(() => import('@/components/backgrounds/floating-lines'), {
  ssr: false,
})

/**
 * Ambient blue line field behind the hero. Non-interactive (no pointer, no parallax).
 * Enters from the left of the screen and settles into place, timed to run alongside the
 * hero title animation so the two feel coordinated rather than the lines popping in late.
 */
export function FloatingLinesBg() {
  return (
    <motion.div
      className="pointer-events-none absolute inset-0 z-0 select-none"
      aria-hidden="true"
      initial={{ x: '-100%', opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
    >
      <FloatingLines
        interactive={false}
        parallax={false}
        linesGradient={['#1D4ED8', '#3B82F6', '#60A5FA']}
        opacity={0.35}
      />
    </motion.div>
  )
}
