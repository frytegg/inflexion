import { Hero } from '@/components/landing/hero'
import { StatsStrip } from '@/components/landing/stats-strip'
import { Pillars } from '@/components/landing/pillars'
import { Guarantee } from '@/components/landing/guarantee'
import { Doors } from '@/components/landing/doors'
import { DataTeaser } from '@/components/landing/data-teaser'

// hero → stats → pillars (how it works) → guarantee (the bridge) → doors (what you do) → data teaser
export default function LandingPage() {
  return (
    <>
      <Hero />
      <StatsStrip />
      <Pillars />
      <Guarantee />
      <Doors />
      <DataTeaser />
    </>
  )
}
