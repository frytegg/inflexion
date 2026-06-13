// Display formatters. dUSDC/USDC = 6 decimals (the numéraire); dWETH = 18; WAD =
// 1e18 (ratios); bps = /10000. Numbers always render in mono/tabular (see ui.tsx).
import { formatUnits } from 'viem'

const USDC_DECIMALS = 6

function withCommas(s: string): string {
  const [int, frac] = s.split('.')
  const grouped = (int ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return frac !== undefined ? `${grouped}.${frac}` : grouped
}

/** Raw 6-dec dUSDC → human string, default 2dp. */
export function fmtUsdc(raw: bigint, dp = 2): string {
  const n = Number(formatUnits(raw, USDC_DECIMALS))
  return withCommas(n.toFixed(dp))
}

/** Raw 6-dec dUSDC → `$1,234.56`. */
export function fmtUsd(raw: bigint, dp = 2): string {
  return `$${fmtUsdc(raw, dp)}`
}

/** Raw token amount → human string. */
export function fmtToken(raw: bigint, decimals: number, dp = 4): string {
  const n = Number(formatUnits(raw, decimals))
  return withCommas(n.toFixed(dp))
}

/** Parse a user dUSDC string (e.g. "100.5") → raw 6-dec bigint. */
export function parseUsdc(value: string): bigint {
  const cleaned = value.trim()
  if (!cleaned || Number.isNaN(Number(cleaned))) return 0n
  const [int, frac = ''] = cleaned.split('.')
  const fracPadded = (frac + '0'.repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS)
  return BigInt((int || '0') + fracPadded)
}

/** A plain ratio (0–1+) → `12.34%`. */
export function fmtPct(x: number, dp = 2): string {
  return `${(x * 100).toFixed(dp)}%`
}

/** WAD (1e18) → percentage string, e.g. fmtWadPct(0.05e18) = "5.00%". */
export function fmtWadPct(wad: bigint, dp = 2): string {
  return `${((Number(wad) / 1e18) * 100).toFixed(dp)}%`
}

/** WAD (1e18) → plain number string. */
export function fmtWad(wad: bigint, dp = 4): string {
  return (Number(wad) / 1e18).toFixed(dp)
}

/** bps → `5.00%`. */
export function fmtBps(bps: number | bigint, dp = 2): string {
  return `${(Number(bps) / 100).toFixed(dp)}%`
}

/** A very large integer (e.g. Uniswap v3 liquidity) → compact `1.53e17`. */
export function fmtCompact(raw: bigint, dp = 2): string {
  return Number(raw).toExponential(dp).replace('e+', 'e')
}

/** `0xC198…4848` */
export function truncAddr(a?: string, head = 6, tail = 4): string {
  if (!a) return '—'
  return a.length > head + tail ? `${a.slice(0, head)}…${a.slice(-tail)}` : a
}

/** `0x67c4…9d69` for bytes32 ids. */
export function truncHex(h?: string): string {
  return truncAddr(h, 8, 6)
}

/** unix seconds → `2026-06-05` (UTC date). */
export function fmtDate(seconds: number | bigint): string {
  return new Date(Number(seconds) * 1000).toISOString().slice(0, 10)
}

/** seconds → `7d` / `12h` / `300s`. */
export function fmtDuration(seconds: number | bigint): string {
  const s = Number(seconds)
  if (s % 86400 === 0) return `${s / 86400}d`
  if (s % 3600 === 0) return `${s / 3600}h`
  if (s % 60 === 0) return `${s / 60}m`
  return `${s}s`
}
