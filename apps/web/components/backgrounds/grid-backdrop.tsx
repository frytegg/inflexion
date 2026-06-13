// Subtle, static, on-brand page backdrop for the app surfaces — a faint terminal
// grid + the inflection (sigmoid) motif + a single teal glow. Pure CSS/SVG (no
// WebGL), fixed behind all content. Ties the app pages to the landing hero without
// competing with the data. Provides the `canvas` token as its own base layer.
export function GridBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-canvas">
      {/* terminal grid */}
      <svg className="absolute inset-0 h-full w-full text-line-subtle" style={{ opacity: 0.5 }}>
        <defs>
          <pattern id="ix-grid" width="56" height="56" patternUnits="userSpaceOnUse">
            <path d="M56 0H0V56" fill="none" stroke="currentColor" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#ix-grid)" />
      </svg>
      {/* the inflection motif — a faint sigmoid sweeping up to the right */}
      <svg
        className="absolute inset-x-0 top-1/4 h-[60vh] w-full"
        viewBox="0 0 1000 600"
        preserveAspectRatio="xMidYMid slice"
        fill="none"
      >
        <path
          d="M0,470 C250,470 350,300 500,300 S750,130 1000,130"
          stroke="#14B8A6"
          strokeOpacity="0.07"
          strokeWidth="2"
        />
      </svg>
      {/* single teal glow, top-center */}
      <div className="absolute left-1/2 top-[-12%] h-[420px] w-[760px] -translate-x-1/2 rounded-full bg-accent-500/[0.07] blur-[120px]" />
    </div>
  )
}
