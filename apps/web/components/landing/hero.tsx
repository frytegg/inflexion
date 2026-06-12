'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { FloatingLinesBg } from '@/components/landing/floating-lines-bg'
import { TextAnimate } from '@/components/magicui/text-animate'
import { ShimmerButton } from '@/components/magicui/shimmer-button'

export function Hero() {
  const router = useRouter()
  // Fire the title + the background fade at the SAME moment — when WebGL is ready
  // (so neither janks the other). A fallback guarantees the headline never waits on
  // WebGL if it's slow or unsupported.
  const [started, setStarted] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setStarted(true), 600)
    return () => clearTimeout(t)
  }, [])
  const titleAnimate = started ? 'show' : 'hidden'

  return (
    <section className="relative overflow-hidden">
      <FloatingLinesBg onReady={() => setStarted(true)} />
      <div className="relative z-10 mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center px-6 py-16 text-center">
        <h1 className="font-title text-display-xl leading-[1.05] text-fg md:text-display-2xl">
          <TextAnimate
            as="span"
            by="word"
            animation="slideUp"
            startOnView={false}
            animate={titleAnimate}
            className="block"
          >
            Hedge in-range
          </TextAnimate>
          <TextAnimate
            as="span"
            by="word"
            animation="slideUp"
            startOnView={false}
            animate={titleAnimate}
            delay={0.15}
            className="block"
          >
            impermanent loss.
          </TextAnimate>
        </h1>
        <p className="mt-5 max-w-xl text-body-lg text-fg-secondary">
          Pay a fixed premium, transfer the in-range IL risk of your Uniswap v3 position. Paid your
          realized IL at expiry —{' '}
          <span className="text-fg">
            capped at <span className="num text-warn-400">MaxIL</span>
          </span>
          .
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <ShimmerButton onClick={() => router.push('/protect')}>Protect a position</ShimmerButton>
          <ShimmerButton onClick={() => router.push('/data')}>See the data</ShimmerButton>
        </div>
      </div>
    </section>
  )
}
