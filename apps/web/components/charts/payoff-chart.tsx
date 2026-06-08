import { scaleLinear } from '@visx/scale'
import { LinePath, AreaClosed, Area, Line } from '@visx/shape'
import { Group } from '@visx/group'
import { curveMonotoneX } from '@visx/curve'
import { computePayoffCurve, type PayoffGeometry, type PayoffPoint } from '@/lib/payoff'

// Fixed viewBox; responsive via width:100% + preserveAspectRatio. Server-rendered
// (pure SVG from deterministic geometry) — instant paint, no client JS.
const W = 600
const H = 440
const M = { top: 30, right: 20, bottom: 42, left: 30 }
const IW = W - M.left - M.right
const IH = H - M.top - M.bottom

// tokens (DESIGN_TOKENS.md) — inlined for the SVG presentation attributes
const C = {
  teal: '#2DD4BF',
  loss: '#F87171',
  cap: '#FBBF24',
  grid: '#1B2740',
  axis: '#707E96',
}

export function PayoffChart({
  geometry,
  className,
}: {
  geometry: PayoffGeometry
  className?: string
}) {
  const curve = computePayoffCurve(geometry)
  const x = scaleLinear({ domain: [curve.pMin, curve.pMax], range: [0, IW] })
  const yMax = Math.max(...curve.points.map((p) => p.ilPct)) * 1.04
  const y = scaleLinear({ domain: [0, yMax], range: [IH, 0] })

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
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={className}
      role="img"
      aria-label="Payoff with cap — IL is covered up to MaxIL while in range, then capped beyond it."
      preserveAspectRatio="xMidYMid meet"
    >
      <Group left={M.left} top={M.top}>
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
        {/* uncovered region — true IL above the cap, beyond the range (red). Zero in-range. */}
        <Area
          data={curve.points}
          x={px}
          y0={pPay}
          y1={pIl}
          curve={curveMonotoneX}
          fill={C.loss}
          fillOpacity={0.14}
        />
        {/* true IL — keeps growing beyond the range (faint dashed red) */}
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
        <text x={0} y={-14} className="font-mono" fill={C.axis} fontSize={11}>
          loss · % of position
        </text>
        <text x={IW} y={IH + 36} textAnchor="end" className="font-mono" fill={C.axis} fontSize={11}>
          price →
        </text>
      </Group>
    </svg>
  )
}
