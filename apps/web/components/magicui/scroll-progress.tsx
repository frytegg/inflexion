'use client'

import { motion, useScroll } from 'framer-motion'

import { cn } from '@/lib/utils'

// MagicUI ScrollProgress (@magicui/scroll-progress). Adapted: imports from
// `framer-motion` (this repo's motion lib), Tailwind v3 `bg-gradient-to-r`, and the
// Inflexion teal → blue brand gradient instead of the default pink/purple.
export function ScrollProgress({ className }: { className?: string }) {
  const { scrollYProgress } = useScroll()

  return (
    <motion.div
      className={cn(
        'fixed inset-x-0 top-0 z-[60] h-0.5 origin-left bg-gradient-to-r from-[#14B8A6] via-[#3B82F6] to-[#5EEAD4]',
        className,
      )}
      style={{ scaleX: scrollYProgress }}
    />
  )
}
