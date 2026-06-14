'use client'

import { useMemo, useState, type MouseEvent } from 'react'
import { scaleLinear } from '@visx/scale'
import { LinePath, AreaClosed, Area, Line } from '@visx/shape'
import { Group } from '@visx/group'
import { curveMonotoneX } from '@visx/curve'
import { cn } from '@/lib/utils'
import { computePayoffCurve, type PayoffPoint, type PayoffGeometry } from '@/lib/payoff'

// Horizontal banner proportions; responsive via width:100% + preserveAspectRatio.
const W = 1080
const H = 300
const M = { top: 24, right: 28, bottom: 38, left: 40 }
const IW = W - M.left - M.right
const IH = H - M.top - M.bottom

// tokens (DESIGN_TOKENS.md) — inlined for the SVG presentation attributes
const C = {
  teal: '#2DD4BF',
  loss: '#F87171',
  cap: '#FBBF24',
  grid: '#1B2740',
  axis: '#707E96',
  canvas: '#0B1220',
}

/** Piecewise-linear true-IL% at a price, over the (ascending-by-p) curve points. */
function ilPctAtPrice(points: PayoffPoint[], price: number): number {
  const n = points.length
  if (n === 0) return 0
  if (price <= points[0]!.p) return points[0]!.ilPct
  if (price >= points[n - 1]!.p) return points[n - 1]!.ilPct
  for (let i = 1; i < n; i++) {
    const b = points[i]!
    if (price <= b.p) {
      const a = points[i - 1]!
      const t = (price - a.p) / (b.p - a.p)
      return a.ilPct + t * (b.ilPct - a.ilPct)
    }
  }
  return points[n - 1]!.ilPct
}

export function PayoffChart({
  geometry,
  className,
}: {
  geometry: PayoffGeometry
  className?: string
}) {
  const curve = useMemo(() => computePayoffCurve(geometry), [geometry.pa, geometry.p0, geometry.pb])
  const x = useMemo(
    () => scaleLinear({ domain: [curve.pMin, curve.pMax], range: [0, IW] }),
    [curve.pMin, curve.pMax],
  )
  const yMax = useMemo(() => Math.max(...curve.points.map((p) => p.ilPct)) * 1.04, [curve])
  const y = useMemo(() => scaleLinear({ domain: [0, yMax], range: [IH, 0] }), [yMax])

  // The static curve — recomputed only when the geometry/scales change, never per
  // hover frame, so tracking stays cheap (only the cursor reconciles).
  const staticChart = useMemo(() => {
    const px = (d: PayoffPoint): number => x(d.p)
    const pIl = (d: PayoffPoint): number => y(d.ilPct)
    const pPay = (d: PayoffPoint): number => y(d.payoutPct)
    const capY = y(curve.maxILPct)
    const markers: Array<[string, number]> = [
      ['Pa', curve.pa],
      ['P0', curve.p0],
      ['Pb', curve.pb],
    ]
    return (
      <>
        {/* covered region — what you're paid (teal) */}
        <AreaClosed
          data={curve.points}
          x={px}
          y={pPay}
          yScale={y}
          curve={curveMonotoneX}
          fill={C.teal}
          fillOpacity={0.16}
        />
        {/* uncovered region — true IL above the cap (red). Zero where IL ≤ cap. */}
        <Area
          data={curve.points}
          x={px}
          y0={pPay}
          y1={pIl}
          curve={curveMonotoneX}
          fill={C.loss}
          fillOpacity={0.14}
        />
        {/* true IL — keeps growing past the cap (faint dashed red) */}
        <LinePath
          data={curve.points}
          x={px}
          y={pIl}
          curve={curveMonotoneX}
          stroke={C.loss}
          strokeWidth={1.5}
          strokeOpacity={0.65}
          strokeDasharray="3 3"
        />
        {/* payout — what you actually receive (bold teal) */}
        <LinePath
          data={curve.points}
          x={px}
          y={pPay}
          curve={curveMonotoneX}
          stroke={C.teal}
          strokeWidth={2.75}
        />

        {/* vertical range markers */}
        {markers.map(([label, value]) => (
          <Group key={label}>
            <Line
              from={{ x: x(value), y: 0 }}
              to={{ x: x(value), y: IH }}
              stroke={C.grid}
              strokeWidth={1}
            />
            <text
              x={x(value)}
              y={IH + 18}
              textAnchor="middle"
              className="font-mono"
              fill={C.axis}
              fontSize={11}
            >
              {label}
            </text>
          </Group>
        ))}

        {/* THE MaxIL CAP — the hero of the chart: amber, dominant, glowing label */}
        <Line
          from={{ x: 0, y: capY }}
          to={{ x: IW, y: capY }}
          stroke={C.cap}
          strokeWidth={2.5}
          strokeDasharray="8 5"
        />
        <rect
          x={IW - 92}
          y={capY - 24}
          width={92}
          height={18}
          rx={3}
          fill={C.cap}
          fillOpacity={0.12}
        />
        <text
          x={IW - 8}
          y={capY - 11}
          textAnchor="end"
          className="font-mono"
          fill={C.cap}
          fontSize={11}
          fontWeight={600}
        >
          MaxIL cap
        </text>

        {/* axis hints */}
        <text x={0} y={-10} className="font-mono" fill={C.axis} fontSize={11}>
          loss · % of position
        </text>
        <text x={IW} y={IH + 32} textAnchor="end" className="font-mono" fill={C.axis} fontSize={11}>
          price →
        </text>
      </>
    )
  }, [curve, x, y])

  // ── Hover cursor ───────────────────────────────────────────────────────────
  // Follows the mouse along the price axis and reads out coverage AT that price.
  // COVERAGE = realized IL ≤ MaxIL (your loss is paid in full) → teal "covered".
  // Beyond the cap (IL > MaxIL) the payout is capped and the excess is uncovered
  // → red "capped". (This is IL-vs-cap, NOT in/out of the Pa…Pb range — just past
  // Pb the IL can still be below the cap, i.e. covered.) Idle: rest at P0.
  const [hoverPrice, setHoverPrice] = useState<number | null>(null)

  const onMove = (e: MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const vbX = ((e.clientX - rect.left) / rect.width) * W
    const plotX = Math.max(0, Math.min(IW, vbX - M.left))
    setHoverPrice(x.invert(plotX))
  }

  const price = hoverPrice ?? curve.p0
  const ilPct = ilPctAtPrice(curve.points, price)
  const covered = ilPct <= curve.maxILPct + 1e-3
  const cursorColor = covered ? C.teal : C.loss
  const cursorX = x(price)
  const cursorY = y(ilPct)
  const labelX = Math.max(54, Math.min(IW - 54, cursorX))

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={cn('cursor-crosshair', className)}
      role="img"
      aria-label="Payoff with cap — hover to read coverage at any price; IL is paid in full up to MaxIL, then capped."
      preserveAspectRatio="xMidYMid meet"
      onMouseMove={onMove}
      onMouseLeave={() => setHoverPrice(null)}
    >
      <Group left={M.left} top={M.top}>
        {staticChart}

        {/* cursor: vertical playhead + dot riding the true-IL curve, coloured by coverage */}
        <line
          x1={cursorX}
          x2={cursorX}
          y1={0}
          y2={IH}
          stroke={cursorColor}
          strokeWidth={1.5}
          strokeOpacity={0.85}
        />
        <circle
          cx={cursorX}
          cy={cursorY}
          r={5}
          fill={cursorColor}
          stroke={C.canvas}
          strokeWidth={2}
        />

        {/* status pill at the cursor — "covered" (teal) / "capped" (red) + the loss % */}
        <g transform={`translate(${labelX} 0)`}>
          <rect
            x={-54}
            y={4}
            width={108}
            height={18}
            rx={3}
            fill={cursorColor}
            fillOpacity={0.16}
          />
          <text
            x={0}
            y={17}
            textAnchor="middle"
            className="font-mono"
            fill={cursorColor}
            fontSize={11}
            fontWeight={600}
          >
            {covered ? 'covered' : 'capped'} · {ilPct.toFixed(1)}%
          </text>
        </g>
      </Group>
    </svg>
  )
}
