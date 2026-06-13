// Human token symbols + pair labels for the demo (and real) pairs. Centralised so
// every surface renders "dWETH / dUSDC" consistently instead of raw addresses.
import { tokens } from '@inflexion/sdk'
import { truncAddr } from './format'

const TOKEN_SYMBOLS: Record<string, string> = {
  [tokens.demoWeth.toLowerCase()]: 'dWETH',
  [tokens.demoUsdc.toLowerCase()]: 'dUSDC',
  [tokens.weth.toLowerCase()]: 'WETH',
  [tokens.usdc.toLowerCase()]: 'USDC',
}

/** Token address → symbol (falls back to a short address for unknown tokens). */
export function symbolOf(addr: string): string {
  return TOKEN_SYMBOLS[addr.toLowerCase()] ?? truncAddr(addr)
}

/** A readable pair label, "dWETH / dUSDC" (volatile token0 / numéraire token1). */
export function pairLabel(token0: string, token1: string): string {
  return `${symbolOf(token0)} / ${symbolOf(token1)}`
}

/** Every demo market is the dWETH/dUSDC pair — header + degraded-row fallback label. */
export const DEMO_PAIR = pairLabel(tokens.demoWeth, tokens.demoUsdc)
