'use client'

// Shared UI primitives — terminal/quant flavored, tokens from DESIGN_TOKENS.md.
// Function-first; the design pass refines later.
import { type ReactNode, type InputHTMLAttributes } from 'react'
import { useAccount } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { cn } from '@/lib/utils'

// ─── Spinner ──────────────────────────────────────────────────────────────────
export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('h-3.5 w-3.5 animate-spin', className)} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

// ─── Button ───────────────────────────────────────────────────────────────────
type ButtonVariant = 'primary' | 'ghost' | 'danger'
const BTN: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-600 disabled:bg-accent/40',
  ghost: 'border border-line-strong text-fg hover:border-fg-tertiary disabled:opacity-40',
  danger: 'border border-loss/50 text-loss hover:bg-loss/10 disabled:opacity-40',
}

export function Button({
  variant = 'primary',
  className,
  children,
  ...rest
}: { variant?: ButtonVariant } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2.5 text-body-sm font-medium transition-colors duration-fast disabled:cursor-not-allowed',
        BTN[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

// ─── TxButton (status-aware) ────────────────────────────────────────────────────
import type { TxStatus } from '@/lib/use-tx'
export function TxButton({
  status,
  busyLabel,
  children,
  variant = 'primary',
  className,
  disabled,
  ...rest
}: {
  status: TxStatus
  busyLabel?: string
  variant?: ButtonVariant
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const busy = status === 'signing' || status === 'pending'
  const label =
    status === 'signing'
      ? (busyLabel ?? 'Confirm in wallet…')
      : status === 'pending'
        ? 'Pending…'
        : children
  return (
    <Button variant={variant} className={className} disabled={disabled || busy} {...rest}>
      {busy && <Spinner />}
      {label}
    </Button>
  )
}

// ─── Card / Panel / Section ─────────────────────────────────────────────────────
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('rounded-lg border border-line bg-raised p-5', className)}>{children}</div>
  )
}

/** Terminal-style panel with a hairline title bar. */
export function Panel({
  title,
  right,
  className,
  children,
}: {
  title?: ReactNode
  right?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn('rounded-lg border border-line bg-raised', className)}>
      {(title || right) && (
        <div className="flex items-center justify-between border-b border-line-subtle px-5 py-3">
          <span className="text-label uppercase text-fg-tertiary">{title}</span>
          {right}
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  )
}

export function Section({
  title,
  kicker,
  children,
}: {
  title?: string
  kicker?: string
  children: ReactNode
}) {
  return (
    <section className="mx-auto max-w-6xl px-6 py-8">
      {kicker && <p className="text-label uppercase text-accent-400">{kicker}</p>}
      {title && <h1 className="mt-2 font-display text-h1 font-bold text-fg">{title}</h1>}
      <div className="mt-6">{children}</div>
    </section>
  )
}

// ─── Stat ───────────────────────────────────────────────────────────────────────
export function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: ReactNode
  value: ReactNode
  sub?: ReactNode
  accent?: 'teal' | 'loss' | 'warn'
}) {
  const c =
    accent === 'teal'
      ? 'text-accent-400'
      : accent === 'loss'
        ? 'text-loss'
        : accent === 'warn'
          ? 'text-warn-400'
          : 'text-fg'
  return (
    <div>
      <div className="text-label uppercase text-fg-tertiary">{label}</div>
      <div className={cn('num mt-1 text-mono-stat', c)}>{value}</div>
      {sub && <div className="mt-1 text-body-sm text-fg-tertiary">{sub}</div>}
    </div>
  )
}

// ─── Field + AmountInput ─────────────────────────────────────────────────────────
export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="text-label uppercase text-fg-tertiary">{label}</span>
      <div className="mt-2">{children}</div>
      {hint && <span className="mt-1 block text-body-sm text-fg-tertiary">{hint}</span>}
    </label>
  )
}

export function AmountInput({
  suffix = 'dUSDC',
  onMax,
  className,
  ...rest
}: { suffix?: string; onMax?: () => void } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border border-line bg-inset px-3 py-2.5 focus-within:border-accent-700',
        className,
      )}
    >
      <input
        inputMode="decimal"
        className="num w-full bg-transparent text-mono text-fg outline-none placeholder:text-fg-disabled"
        {...rest}
      />
      {onMax && (
        <button
          type="button"
          onClick={onMax}
          className="text-label uppercase text-accent-400 hover:text-accent-300"
        >
          Max
        </button>
      )}
      <span className="text-body-sm text-fg-tertiary">{suffix}</span>
    </div>
  )
}

// ─── Badge ────────────────────────────────────────────────────────────────────
type BadgeTone = 'teal' | 'loss' | 'warn' | 'mm' | 'neutral'
const BADGE: Record<BadgeTone, string> = {
  teal: 'border-accent-700 text-accent-300',
  loss: 'border-loss/40 text-loss',
  warn: 'border-warn-500/40 text-warn-400',
  mm: 'border-mm/40 text-mm-400',
  neutral: 'border-line-strong text-fg-secondary',
}
export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-label uppercase',
        BADGE[tone],
      )}
    >
      {children}
    </span>
  )
}

// ─── States ─────────────────────────────────────────────────────────────────────
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-overlay', className)} />
}

export function EmptyState({
  title,
  desc,
  action,
}: {
  title: string
  desc?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-base px-6 py-12 text-center">
      <p className="font-display text-h4 text-fg">{title}</p>
      {desc && <p className="mx-auto mt-2 max-w-md text-body-sm text-fg-tertiary">{desc}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  )
}

/** The honest "needs the subgraph/API" state — render this, never an error. */
export function PendingNote({ children }: { children?: ReactNode }) {
  return (
    <div className="rounded-md border border-warn-500/30 bg-warn-500/5 px-4 py-3 text-body-sm text-warn-400">
      {children ?? 'Live once the subgraph + API are deployed. The on-chain data is available now.'}
    </div>
  )
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-loss/30 bg-loss/5 px-4 py-3 text-body-sm text-loss">
      {children}
    </div>
  )
}

// ─── ConnectGate ────────────────────────────────────────────────────────────────
/** Renders children only when a wallet is connected; otherwise prompts to connect. */
export function ConnectGate({ children, message }: { children: ReactNode; message?: string }) {
  const { isConnected } = useAccount()
  if (isConnected) return <>{children}</>
  return (
    <EmptyState
      title="Connect your wallet"
      desc={message ?? 'Connect a wallet on Arbitrum Sepolia to continue.'}
      action={<ConnectButton showBalance={false} />}
    />
  )
}
