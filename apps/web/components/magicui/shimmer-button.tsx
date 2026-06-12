import React, { type ComponentPropsWithoutRef, type CSSProperties } from 'react'

import { cn } from '@/lib/utils'

export interface ShimmerButtonProps extends ComponentPropsWithoutRef<'button'> {
  shimmerColor?: string
  shimmerSize?: string
  borderRadius?: string
  shimmerDuration?: string
  background?: string
  className?: string
  children?: React.ReactNode
}

/**
 * MagicUI ShimmerButton (@magicui/shimmer-button), adapted for this repo's Tailwind v3:
 * - the `shimmer-slide` / `spin-around` keyframes live in tailwind.config.ts (not v4 @theme)
 * - `@container-[size]` → an inline `container-type: size`
 * - the conic-gradient spark → the `.shimmer-spark` class in globals.css (valid calc spacing)
 * - `inset-(--cut)` → `inset-[var(--cut)]`, `size-full` → `h-full w-full`
 */
export const ShimmerButton = React.forwardRef<HTMLButtonElement, ShimmerButtonProps>(
  (
    {
      shimmerColor = '#ffffff',
      shimmerSize = '0.05em',
      shimmerDuration = '3s',
      borderRadius = '100px',
      background = 'rgba(0, 0, 0, 1)',
      className,
      children,
      ...props
    },
    ref,
  ) => {
    return (
      <button
        style={
          {
            '--spread': '90deg',
            '--shimmer-color': shimmerColor,
            '--radius': borderRadius,
            '--speed': shimmerDuration,
            '--cut': shimmerSize,
            '--bg': background,
          } as CSSProperties
        }
        className={cn(
          'group relative z-0 flex cursor-pointer items-center justify-center overflow-hidden whitespace-nowrap border border-white/10 px-6 py-3 text-white [background:var(--bg)] [border-radius:var(--radius)]',
          'transform-gpu transition-transform duration-300 ease-in-out active:translate-y-px',
          className,
        )}
        ref={ref}
        {...props}
      >
        {/* spark container */}
        <div
          style={{ containerType: 'size' } as CSSProperties}
          className="absolute inset-0 -z-30 overflow-visible blur-[2px]"
        >
          {/* spark */}
          <div className="animate-shimmer-slide absolute inset-0 aspect-square h-[100cqh] [mask:none]">
            {/* spark before */}
            <div className="animate-spin-around shimmer-spark absolute -inset-full w-auto rotate-0 [translate:0_0]" />
          </div>
        </div>
        {children}

        {/* Highlight */}
        <div
          className={cn(
            'absolute inset-0 h-full w-full',
            'rounded-2xl px-4 py-1.5 text-sm font-medium shadow-[inset_0_-8px_10px_#ffffff1f]',
            // transition
            'transform-gpu transition-all duration-300 ease-in-out',
            // on hover
            'group-hover:shadow-[inset_0_-6px_10px_#ffffff3f]',
            // on click
            'group-active:shadow-[inset_0_-10px_10px_#ffffff3f]',
          )}
        />

        {/* backdrop */}
        <div className="absolute inset-[var(--cut)] -z-20 [background:var(--bg)] [border-radius:var(--radius)]" />
      </button>
    )
  },
)

ShimmerButton.displayName = 'ShimmerButton'
