'use client'

import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'

// FloatingLines uses WebGL (three.js) — load it client-only.
const FloatingLines = dynamic(() => import('@/components/backgrounds/floating-lines'), {
  ssr: false,
})

/**
 * Ambient blue line field behind the hero. Non-interactive (no pointer, no parallax).
 * It mounts a beat AFTER the page so the hero title animates on a free main thread
 * (no WebGL-init jank), then fades in slowly while the waves drift — appearing and
 * flowing into their shape rather than popping in or sliding (which janks the canvas).
 */
export function FloatingLinesBg() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    // Let the title animation finish first, then bring the background in.
    const t = setTimeout(() => setReady(true), 500)
    return () => clearTimeout(t)
  }, [])

  if (!ready) return null

  return (
    <motion.div
      className="pointer-events-none absolute inset-0 z-0 select-none"
      aria-hidden="true"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 1.8, ease: 'easeOut' }}
    >
      <FloatingLines
        interactive={false}
        parallax={false}
        animationSpeed={0.6}
        linesGradient={['#1D4ED8', '#3B82F6', '#60A5FA']}
        opacity={0.35}
      />
    </motion.div>
  )
}
