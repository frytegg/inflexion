import Link from 'next/link'
import { FloatingLinesBg } from '@/components/landing/floating-lines-bg'
import { TextAnimate } from '@/components/magicui/text-animate'

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <FloatingLinesBg />
      <div className="relative z-10 mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center px-6 py-16 text-center">
        <h1 className="font-title text-display-xl leading-[1.05] text-fg md:text-display-2xl">
          <TextAnimate as="span" by="word" animation="slideUp" className="block">
            Hedge in-range
          </TextAnimate>
          <TextAnimate as="span" by="word" animation="slideUp" delay={0.15} className="block">
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
          <Link
            href="/protect"
            className="rounded-lg bg-accent px-5 py-3 font-medium text-accent-fg shadow-glow transition-colors duration-fast hover:bg-accent-600"
          >
            Protect a position
          </Link>
          <Link
            href="/data"
            className="rounded-lg border border-line-strong px-5 py-3 font-medium text-fg transition-colors duration-fast hover:border-fg-tertiary"
          >
            See the data
          </Link>
        </div>
        <p className="mt-6 text-body-sm text-fg-tertiary">
          No bad debt under FULL · firm on-chain pricing · no last-look.
        </p>
      </div>
    </section>
  )
}
