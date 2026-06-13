'use client'

// The shared app-page style layer — the landing's visual language (display
// headlines, accent eyebrows, hairline frames, restrained entrance motion, a
// shimmer CTA) applied to the functional dApp surfaces. Colors/fonts/spacing come
// straight from DESIGN_TOKENS.md; this only governs composition + motion, so every
// app page reads as the same product as the landing.
import { type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Spinner } from '@/components/ui'
import { ShimmerButton } from '@/components/magicui/shimmer-button'
import type { TxStatus } from '@/lib/use-tx'

/** Page width + rhythm wrapper (app rhythm ~56px, not the landing's 96–128px). */
export function PageShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn('mx-auto max-w-6xl px-6 py-10 md:py-14', className)}>{children}</section>
  )
}

/** Subtle entrance: fade + 8px slide-up, viewport-triggered, reduced-motion-safe. */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode
  delay?: number
  className?: string
}) {
  // Pure CSS entrance (.ix-reveal in globals.css). A plain <div> with a static class
  // → identical markup on server and client, so hydration can never mismatch (framer
  // motion.div diverged on SSR). Reduced motion is honored by the global
  // prefers-reduced-motion rule, which collapses the animation duration.
  const style: CSSProperties | undefined = delay ? { animationDelay: `${delay}s` } : undefined
  return (
    <div className={cn('ix-reveal', className)} style={style}>
      {children}
    </div>
  )
}

/** Landing-style page intro: eyebrow → big display headline → lead paragraph. */
export function PageHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string
  title: string
  children?: ReactNode
}) {
  return (
    <Reveal className="mx-auto max-w-2xl text-center">
      {eyebrow && <p className="text-label uppercase text-accent-400">{eyebrow}</p>}
      <h1 className="mt-3 font-display text-display-lg font-bold text-fg">{title}</h1>
      {children && <div className="mt-4 text-body-lg text-fg-secondary">{children}</div>}
    </Reveal>
  )
}

/**
 * The app's primary surface: a clean hairline rectangle carrying the landing's teal
 * corner-node motif, with an accent eyebrow title. A real bordered box (not the
 * marketing card's inset rails) so panels align edge-to-edge in a grid — the user
 * wants components to "fit in a rectangle." `flex flex-col` + a growing body let it
 * fill an equal-height grid cell (pass `h-full` / `flex-1` via className).
 */
export function FramedPanel({
  title,
  right,
  children,
  className,
}: {
  title?: ReactNode
  right?: ReactNode
  children: ReactNode
  className?: string
}) {
  // A teal node sitting on each corner — the dots motif, punched through the border
  // by a canvas-colored ring so it reads as the landing's node.
  const node =
    'pointer-events-none absolute z-10 h-1.5 w-1.5 rounded-full bg-accent-400 outline outline-4 outline-canvas'
  return (
    <div
      className={cn(
        'relative flex flex-col rounded-lg border border-line-strong bg-base/40',
        className,
      )}
    >
      <span className={cn(node, '-left-[3px] -top-[3px]')} />
      <span className={cn(node, '-right-[3px] -top-[3px]')} />
      <span className={cn(node, '-bottom-[3px] -left-[3px]')} />
      <span className={cn(node, '-bottom-[3px] -right-[3px]')} />
      <div className="flex flex-1 flex-col p-6">
        {(title || right) && (
          <div className="mb-5 flex items-center justify-between gap-3">
            <span className="text-label uppercase text-accent-400">{title}</span>
            {right}
          </div>
        )}
        <div className="flex flex-1 flex-col">{children}</div>
      </div>
    </div>
  )
}

/** Primary CTA in the landing's shimmer style, but tx-status-aware (spinner + labels). */
export function ShimmerTxButton({
  status,
  busyLabel,
  children,
  disabled,
  className,
  ...rest
}: { status: TxStatus; busyLabel?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const busy = status === 'signing' || status === 'pending'
  const label =
    status === 'signing'
      ? (busyLabel ?? 'Confirm in wallet…')
      : status === 'pending'
        ? 'Pending…'
        : children
  return (
    <ShimmerButton
      disabled={disabled || busy}
      className={cn(
        'gap-2 text-body-sm font-medium disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...rest}
    >
      {busy && <Spinner />}
      {label}
    </ShimmerButton>
  )
}
