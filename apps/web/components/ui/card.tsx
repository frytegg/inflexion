import * as React from 'react'

import { cn } from '@/lib/utils'

export type CardVariant =
  | 'default'
  | 'dots'
  | 'gradient'
  | 'plus'
  | 'neubrutalism'
  | 'inner'
  | 'lifted'
  | 'corners'

// Ported from the source component, recolored from its zinc/gray/green + `dark:` prefixes
// to this app's dark-only tokens (navy canvas/base/raised surfaces, `line` borders, teal
// accent). The app has no `.dark` class, so dark: variants would never fire — the dark
// values are applied directly. cva isn't a dependency here, so the variant → class map is
// a plain lookup merged through `cn` (twMerge resolves any overrides passed via className).
const cardVariants: Record<CardVariant, string> = {
  default: 'rounded-lg border border-line bg-raised',
  dots: 'relative mx-auto w-full rounded-lg border border-dashed border-line px-4 sm:px-6 md:px-8',
  gradient: 'relative mx-auto w-full px-4 sm:px-6 md:px-8',
  plus: 'relative border border-dashed border-line-strong',
  neubrutalism:
    'relative border-[0.5px] border-line-strong shadow-[3px_3px_0px_0px_rgba(20,184,166,0.5)]',
  inner: 'rounded-sm border-[0.5px] border-line p-2',
  lifted:
    'relative rounded-xl border border-line-strong bg-raised shadow-[0px_4px_0px_0px_rgba(20,184,166,0.4)]',
  corners: 'relative rounded-md border-2 border-line',
}

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant
  title?: string
  description?: string
  /** Tailwind bg-* class for the corner nodes (dots variant). Defaults to teal accent. */
  dotClassName?: string
}

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('p-6', className)} {...props}>
      {props.children}
    </div>
  ),
)
CardContent.displayName = 'CardContent'

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  (
    { className, variant = 'default', title, description, dotClassName, children, ...props },
    ref,
  ) => {
    const content = (
      <CardContent>
        {title && <h3 className="mb-1 text-lg font-bold text-fg">{title}</h3>}
        {description && <p className="text-fg-secondary">{description}</p>}
        {children}
      </CardContent>
    )

    if (variant === 'dots') {
      const dot = cn(
        'my-4 h-1 w-1 rounded-full bg-accent-400 outline outline-8 outline-canvas sm:my-6 md:my-8',
        dotClassName,
      )
      return (
        <div ref={ref} className={cn(cardVariants.dots, className)} {...props}>
          <div className="absolute left-0 top-4 -z-0 h-px w-full bg-line-strong sm:top-6 md:top-8" />
          <div className="absolute bottom-4 left-0 z-0 h-px w-full bg-line-strong sm:bottom-6 md:bottom-8" />
          <div className="relative w-full border-x border-line-strong">
            <div className="absolute z-0 grid h-full w-full items-center">
              <section className="absolute z-0 grid h-full w-full grid-cols-2 place-content-between">
                <div className={cn(dot, '-translate-x-[2.5px]')} />
                <div className={cn(dot, 'translate-x-[2.5px] place-self-end')} />
                <div className={cn(dot, '-translate-x-[2.5px]')} />
                <div className={cn(dot, 'translate-x-[2.5px] place-self-end')} />
              </section>
            </div>
            <div className="relative z-20 mx-auto py-8">{content}</div>
          </div>
        </div>
      )
    }

    if (variant === 'inner') {
      return (
        <div ref={ref} className={cn(cardVariants.inner, className)} {...props}>
          <div className="rounded-sm border border-line bg-gradient-to-br from-base to-raised shadow-inner">
            {content}
          </div>
        </div>
      )
    }

    if (variant === 'gradient') {
      return (
        <div ref={ref} className={cn(cardVariants.gradient, className)} {...props}>
          <div className="absolute left-0 top-4 -z-0 h-px w-full bg-gradient-to-l from-line via-line-strong to-line sm:top-6 md:top-8" />
          <div className="absolute bottom-4 left-0 z-0 h-px w-full bg-gradient-to-r from-line via-line-strong to-line sm:bottom-6 md:bottom-8" />
          <div className="relative w-full">
            <div className="absolute inset-y-0 left-0 w-px bg-gradient-to-t from-line via-line-strong to-line" />
            <div className="absolute inset-y-0 right-0 w-px bg-gradient-to-t from-line via-line-strong to-line" />
            <div className="relative z-20 mx-auto py-8">{content}</div>
          </div>
        </div>
      )
    }

    const PlusIcons = () => {
      const positions = [
        '-left-3 -top-3',
        '-right-3 -top-3',
        '-bottom-3 -left-3',
        '-bottom-3 -right-3',
      ]
      return (
        <>
          {positions.map((pos) => (
            <svg
              key={pos}
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              width={24}
              height={24}
              strokeWidth="1"
              stroke="currentColor"
              className={cn('absolute h-6 w-6 text-fg-tertiary', pos)}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m6-6H6" />
            </svg>
          ))}
        </>
      )
    }

    const CornerBorders = () => (
      <>
        <div className="absolute -left-0.5 -top-0.5 h-6 w-6 rounded-tl-md border-l-2 border-t-2 border-fg-secondary" />
        <div className="absolute -right-0.5 -top-0.5 h-6 w-6 rounded-tr-md border-r-2 border-t-2 border-fg-secondary" />
        <div className="absolute -bottom-0.5 -left-0.5 h-6 w-6 rounded-bl-md border-b-2 border-l-2 border-fg-secondary" />
        <div className="absolute -bottom-0.5 -right-0.5 h-6 w-6 rounded-br-md border-b-2 border-r-2 border-fg-secondary" />
      </>
    )

    return (
      <div ref={ref} className={cn(cardVariants[variant], className)} {...props}>
        {variant === 'plus' && <PlusIcons />}
        {variant === 'corners' && <CornerBorders />}
        {content}
      </div>
    )
  },
)
Card.displayName = 'Card'

export { Card, CardContent, cardVariants }
