// Payoff-with-cap math — the brand motif. Deterministic Uniswap v3 geometry →
// the true impermanent loss vs hold, and the capped payout min(IL, MaxIL),
// normalized to % of entry value. Shared by the landing hero + /protect /earn
// /underwrite. (Illustrative geometry on the landing; the real position on /protect.)

export interface PayoffGeometry {
  /** lower range price (Pa) */ pa: number
  /** entry price (P0) */ p0: number
  /** upper range price (Pb) */ pb: number
}

export interface PayoffPoint {
  /** price */ p: number
  /** true IL vs hold, % of V0 */ ilPct: number
  /** capped payout = min(IL, MaxIL), % of V0 */ payoutPct: number
}

export interface PayoffCurve {
  points: PayoffPoint[]
  pa: number
  p0: number
  pb: number
  pMin: number
  pMax: number
  /** MaxIL (the cap) as % of V0 */ maxILPct: number
}

const sqrt = Math.sqrt

/** Token amounts of a unit-liquidity v3 position [pa, pb] at price P. */
function amounts(P: number, pa: number, pb: number): { a0: number; a1: number } {
  const sp = sqrt(P)
  const spa = sqrt(pa)
  const spb = sqrt(pb)
  if (P <= pa) return { a0: 1 / spa - 1 / spb, a1: 0 }
  if (P >= pb) return { a0: 0, a1: spb - spa }
  return { a0: 1 / sp - 1 / spb, a1: sp - spa }
}

function lpValue(P: number, pa: number, pb: number): number {
  const { a0, a1 } = amounts(P, pa, pb)
  return a0 * P + a1
}

/**
 * The payoff-with-cap curve. In-range, IL rises from 0 at P0 to MaxIL at the
 * boundary; beyond the range the true IL keeps growing but the payout plateaus
 * at MaxIL — the cap (the product's defining feature).
 */
export function computePayoffCurve(g: PayoffGeometry, samples = 180): PayoffCurve {
  const { pa, p0, pb } = g
  const entry = amounts(p0, pa, pb) // hold these from entry
  const holdValue = (P: number): number => entry.a0 * P + entry.a1
  const v0 = holdValue(p0) // == lpValue(p0) at entry
  const il = (P: number): number => Math.max(holdValue(P) - lpValue(P, pa, pb), 0)
  const maxIL = Math.max(il(pa), il(pb))

  // Extend the domain past the range so the plateau + the diverging true-IL show.
  const span = pb - pa
  const pMin = Math.max(pa * 0.35, pa - span * 0.55)
  const pMax = pb + span * 0.55

  const points: PayoffPoint[] = []
  for (let i = 0; i <= samples; i++) {
    const p = pMin + ((pMax - pMin) * i) / samples
    const ilv = il(p)
    points.push({
      p,
      ilPct: (ilv / v0) * 100,
      payoutPct: (Math.min(ilv, maxIL) / v0) * 100,
    })
  }

  return { points, pa, p0, pb, pMin, pMax, maxILPct: (maxIL / v0) * 100 }
}
