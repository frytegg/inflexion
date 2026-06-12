import { Hero } from '@/components/landing/hero'
import { Pillars } from '@/components/landing/pillars'
import { Guarantee } from '@/components/landing/guarantee'
import { Doors } from '@/components/landing/doors'
import { DataTeaser } from '@/components/landing/data-teaser'

// hero → pillars (how it works) → guarantee (the bridge) → doors (what you do) → data teaser
export default function LandingPage() {
  return (
    <>
      <Hero />
      <Pillars />
      <Guarantee />
      <Doors />
      <DataTeaser />
    </>
  )
}
