# Inflexion — design tokens (locked source of truth)

> The single design source of truth. Every page consumes these tokens — no
> per-page colors/fonts/spacing. **Awaiting approval** (Part 2, step 1). On
> approval, the Tailwind theme + `globals.css` blocks below are materialized into
> the scaffolded Next app, then we wireframe the landing.
>
> Aesthetic: **quant / terminal**. Motif: **INFLEXION = inflection point = convexity**
> — the sigmoid (the `fairRate` S-curve in σ²·T) and the `min(IL, MaxIL)` payoff
> with its visible **cap**. Logo: sigmoid-with-inflection-dot. Principle:
> **data-viz IS the design**; restraint everywhere else; crisp terminal grid, not
> friendly-rounded; hairline borders + surface lift over heavy shadows.

---

## 1. Color

Dark-first. Navy canvas, slate structure, off-white text, teal as the single
brand accent (the "inflection" highlight). Loss-red is load-bearing — this is a
product about capped loss, so the covered/uncovered distinction is a core color job.

### Surfaces (navy)

| Token        | Hex       | Use                                  |
| ------------ | --------- | ------------------------------------ |
| `bg.canvas`  | `#0B1220` | page base (given)                    |
| `bg.base`    | `#0E1525` | default surface                      |
| `bg.raised`  | `#131C30` | cards, panels                        |
| `bg.overlay` | `#18233A` | popovers, modals, dropdowns          |
| `bg.inset`   | `#080E1A` | wells: chart backdrops, inputs, code |

### Borders / lines (slate)

| Token            | Hex       | Use                              |
| ---------------- | --------- | -------------------------------- |
| `border.subtle`  | `#1B2740` | hairlines, gridlines, table rows |
| `border.default` | `#233142` | card & control borders (given)   |
| `border.strong`  | `#2F4156` | hover/active borders, dividers   |

### Foreground (off-white)

| Token          | Hex       | Use                          |
| -------------- | --------- | ---------------------------- |
| `fg.primary`   | `#F3F5F7` | headings, key values (given) |
| `fg.secondary` | `#AEB9CA` | body copy                    |
| `fg.tertiary`  | `#707E96` | labels, captions, axis text  |
| `fg.disabled`  | `#4A5670` | disabled                     |

### Accent — teal (brand)

| Token        | Hex       | Use                                                |
| ------------ | --------- | -------------------------------------------------- |
| `accent.300` | `#5EEAD4` | light highlight, focus glow, sparkles              |
| `accent.400` | `#2DD4BF` | hover, chart strokes                               |
| `accent.500` | `#14B8A6` | **base** — CTAs, links, the inflection dot (given) |
| `accent.600` | `#0E9C8C` | pressed/active                                     |
| `accent.700` | `#0B7D70` | deep, borders on teal fills                        |
| `accent.fg`  | `#06231F` | text/icon ON a teal fill (dark for contrast)       |

### Semantic

| Role               | Token                  | Hex                                           | Use                                                          |
| ------------------ | ---------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| Loss / danger      | `loss.300/400/500/600` | `#FCA5A5` / `#F87171` / `#EF5350` / `#DC4040` | realized IL, uncovered region, "not guaranteed", destructive |
| Caution            | `warn.400/500`         | `#FBBF24` / `#F59E0B`                         | the MaxIL **cap** marker, stale-oracle, risk callouts        |
| MM / info          | `mm.400/500`           | `#7C9CF5` / `#5B7FE0`                         | Path-B / MM accent (distinct from teal=pool)                 |
| Covered / positive | _use_ `accent.*`       | teal                                          | covered region, tx success, gains                            |

> Positive deliberately reuses **teal** (no separate green) to keep the palette
> tight and make "covered = brand" legible. MM uses a blue-violet so **pool (teal)
> vs MM (violet)** read instantly on `/data` and the router UI.

### Data-viz palette (the showpiece)

| Token                | Hex / value                             | Use                                           |
| -------------------- | --------------------------------------- | --------------------------------------------- |
| `viz.curve`          | `#F3F5F7`                               | neutral curve stroke                          |
| `viz.value`          | `#2DD4BF`                               | the priced/value curve                        |
| `viz.covered.fill`   | `#2DD4BF` @ 16%                         | in-range covered region                       |
| `viz.uncovered.fill` | `#F87171` @ 14%                         | beyond-range, loss > cap                      |
| `viz.cap`            | `#FBBF24` (dashed)                      | the **MaxIL ceiling** — the hero concept line |
| `viz.pool`           | `#2DD4BF`                               | Path-A / pool load                            |
| `viz.mm`             | `#8B7FF0`                               | Path-B / MM load                              |
| `viz.grid`           | `#1B2740`                               | gridlines                                     |
| `viz.axis`           | `#707E96`                               | axis labels/ticks                             |
| `viz.heat`           | `#0E2A3A → #14B8A6 → #FBBF24 → #EF5350` | load-surface sequential ramp (low→high)       |

Focus ring: `rgba(20,184,166,0.45)`. Selection: teal @ 25% on navy.

---

## 2. Typography

**Not Inter-everywhere.** A characterful display face + a real tabular mono for
all numbers (financial data wants `tabular-nums`). Three roles; all self-hosted.

| Role            | Proposed (free, self-hostable)             | Alternates                        | Use                                      |
| --------------- | ------------------------------------------ | --------------------------------- | ---------------------------------------- |
| **Display**     | **Clash Display** (Fontshare) — **LOCKED** | Space Grotesk · Unbounded · Syne  | hero, menu & all section headlines       |
| **Sans / UI**   | **General Sans** (Fontshare) — **LOCKED**  | Switzer · Hanken Grotesk          | body, UI, labels                         |
| **Mono / data** | **IBM Plex Mono** (Google) — **LOCKED**    | JetBrains Mono · Spline Sans Mono | **all numbers**, addresses, code, ticker |

> Sans + Mono **locked** 2026-06-05; **Display = Clash Display** picked by visual
> comparison 2026-06-12 (over Space Grotesk · Unbounded · Syne). Its sharp, confident
> geometric forms give the headlines a distinct voice while staying precise — applied to
> every heading (hero, menu, section h2/h3), not just the hero. Constraints kept: display
> ≠ body; mono has true tabular figures; no Inter/Geist as primaries. IBM Plex Mono via
> `next/font/google` (self-hosted); Clash Display + General Sans via the Fontshare CDN.

### Type scale (`rem`, 16px root)

| Token         | Size / line-height | Tracking           | Use                     |
| ------------- | ------------------ | ------------------ | ----------------------- |
| `display-2xl` | 72 / 1.05          | −0.02em            | landing hero            |
| `display-xl`  | 56 / 1.08          | −0.02em            | page heroes             |
| `display-lg`  | 44 / 1.10          | −0.015em           | big section titles      |
| `h1`          | 34 / 1.15          | −0.01em            |                         |
| `h2`          | 26 / 1.20          | −0.01em            |                         |
| `h3`          | 20 / 1.30          | 0                  |                         |
| `h4`          | 17 / 1.40          | 0                  |                         |
| `body-lg`     | 17 / 1.6           | 0                  | lead paragraphs         |
| `body`        | 15 / 1.6           | 0                  | **base**                |
| `body-sm`     | 13 / 1.5           | 0                  | secondary               |
| `label`       | 12 / 1.4           | +0.06em, UPPERCASE | eyebrows, table headers |
| `mono-stat`   | 28 / 1.1           | −0.01em, tabular   | big headline numbers    |
| `mono`        | 15 / 1.5           | 0, tabular         | inline data             |
| `mono-sm`     | 13 / 1.4           | 0, tabular         | dense tables            |
| `mono-xs`     | 11 / 1.4           | +0.02em, tabular   | micro labels, addresses |

Rule: **every numeric value renders in mono with `font-variant-numeric: tabular-nums`** (prices, %, APY, gas, addresses, ids).

---

## 3. Spacing — 4px base

`0, 1=4, 2=8, 3=12, 4=16, 5=20, 6=24, 8=32, 10=40, 12=48, 16=64, 20=80, 24=96, 32=128`
(Tailwind's default scale, kept.) Section rhythm: 96–128px on the landing, 48–64px in the app. Card padding: 20–24px.

## 4. Radius — crisp (terminal, not friendly)

`xs=2, sm=4, md=6, lg=8, xl=12, 2xl=16, full=9999`. Defaults: controls `sm/md`, cards `lg`, modals `xl`. Pills/avatars `full`. **No 20–24px friendly radii** — the quant feel is tight.

## 5. Borders & elevation

Hairline **1px** everywhere; lean on `border.subtle` + a one-step `bg` lift for separation rather than shadows (terminal aesthetic). Shadows reserved for floating layers:

| Token         | Value                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `shadow-sm`   | `0 1px 2px rgba(0,0,0,.30)`                                                                           |
| `shadow-md`   | `0 4px 12px rgba(0,0,0,.35)`                                                                          |
| `shadow-lg`   | `0 12px 32px rgba(0,0,0,.45)`                                                                         |
| `shadow-glow` | `0 0 0 1px rgba(20,184,166,.5), 0 0 24px rgba(20,184,166,.15)` — primary CTA / active only, sparingly |

## 6. Motion — fast, restrained

Durations: `instant 100ms · fast 160ms · base 220ms · slow 320ms`.
Easing: entrance `cubic-bezier(.16,1,.3,1)` (expo-out) · standard `cubic-bezier(.4,0,.2,1)`.
Principles: subtle entrances (fade + 4–8px translate, never big slides); tasteful count-up on key stats; the **inflection dot** may pulse subtly as the one signature flourish; **always respect `prefers-reduced-motion`**. Motion/WebGL libraries are fine — tune them to the tokens (e.g. the teal S-curve `FloatingLines` background) so they read on-brand, not prefab.

## 7. Iconography

**Lucide**, 1.5px stroke, sized 16/20/24, colored `fg.secondary`/`fg.tertiary` (accent only when interactive).

---

## 8. Tailwind theme (materialize on approval → `apps/web/tailwind.config.ts`)

```ts
import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: 'class', // 'dark' is the default + only theme at launch
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // surfaces
        canvas: '#0B1220',
        base: '#0E1525',
        raised: '#131C30',
        overlay: '#18233A',
        inset: '#080E1A',
        // borders
        line: { subtle: '#1B2740', DEFAULT: '#233142', strong: '#2F4156' },
        // foreground
        fg: { DEFAULT: '#F3F5F7', secondary: '#AEB9CA', tertiary: '#707E96', disabled: '#4A5670' },
        // accent (teal) — brand
        accent: {
          300: '#5EEAD4',
          400: '#2DD4BF',
          DEFAULT: '#14B8A6',
          500: '#14B8A6',
          600: '#0E9C8C',
          700: '#0B7D70',
          fg: '#06231F',
        },
        // semantic
        loss: {
          300: '#FCA5A5',
          400: '#F87171',
          DEFAULT: '#EF5350',
          500: '#EF5350',
          600: '#DC4040',
        },
        warn: { 400: '#FBBF24', DEFAULT: '#F59E0B', 500: '#F59E0B' },
        mm: { 400: '#7C9CF5', DEFAULT: '#5B7FE0', 500: '#5B7FE0' },
        // data-viz
        viz: {
          curve: '#F3F5F7',
          value: '#2DD4BF',
          cap: '#FBBF24',
          pool: '#2DD4BF',
          mm: '#8B7FF0',
          grid: '#1B2740',
          axis: '#707E96',
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        'display-2xl': ['4.5rem', { lineHeight: '1.05', letterSpacing: '-0.02em' }],
        'display-xl': ['3.5rem', { lineHeight: '1.08', letterSpacing: '-0.02em' }],
        'display-lg': ['2.75rem', { lineHeight: '1.10', letterSpacing: '-0.015em' }],
        h1: ['2.125rem', { lineHeight: '1.15', letterSpacing: '-0.01em' }],
        h2: ['1.625rem', { lineHeight: '1.20', letterSpacing: '-0.01em' }],
        h3: ['1.25rem', { lineHeight: '1.30' }],
        h4: ['1.0625rem', { lineHeight: '1.40' }],
        'body-lg': ['1.0625rem', { lineHeight: '1.6' }],
        body: ['0.9375rem', { lineHeight: '1.6' }],
        'body-sm': ['0.8125rem', { lineHeight: '1.5' }],
        label: ['0.75rem', { lineHeight: '1.4', letterSpacing: '0.06em' }],
        'mono-stat': ['1.75rem', { lineHeight: '1.1', letterSpacing: '-0.01em' }],
        mono: ['0.9375rem', { lineHeight: '1.5' }],
        'mono-sm': ['0.8125rem', { lineHeight: '1.4' }],
        'mono-xs': ['0.6875rem', { lineHeight: '1.4', letterSpacing: '0.02em' }],
      },
      borderRadius: { xs: '2px', sm: '4px', md: '6px', lg: '8px', xl: '12px', '2xl': '16px' },
      boxShadow: {
        sm: '0 1px 2px rgba(0,0,0,.30)',
        md: '0 4px 12px rgba(0,0,0,.35)',
        lg: '0 12px 32px rgba(0,0,0,.45)',
        glow: '0 0 0 1px rgba(20,184,166,.5), 0 0 24px rgba(20,184,166,.15)',
      },
      transitionTimingFunction: {
        entrance: 'cubic-bezier(.16,1,.3,1)',
        standard: 'cubic-bezier(.4,0,.2,1)',
      },
      transitionDuration: { instant: '100ms', fast: '160ms', base: '220ms', slow: '320ms' },
    },
  },
  plugins: [],
}
export default config
```

## 9. `globals.css` (materialize on approval → `apps/web/app/globals.css`)

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/* Fonts are wired via next/font in app/layout.tsx → CSS vars below.
   --font-display = Clash Display, --font-sans = General Sans, --font-mono = IBM Plex Mono */

:root {
  color-scheme: dark;
  --ring: 20 184 166; /* teal, for focus rings via rgb(var(--ring) / .45) */
}

@layer base {
  html {
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  body {
    background: #0b1220;
    color: #f3f5f7;
    font-family: var(--font-sans), ui-sans-serif, system-ui, sans-serif;
    font-size: 0.9375rem;
    line-height: 1.6;
  }
  /* every number is mono + tabular */
  .num,
  [data-num] {
    font-family: var(--font-mono), ui-monospace, monospace;
    font-variant-numeric: tabular-nums;
  }
  h1,
  h2,
  h3,
  .display {
    font-family: var(--font-display), var(--font-sans), sans-serif;
  }
  ::selection {
    background: rgb(20 184 166 / 0.25);
  }
  :focus-visible {
    outline: 2px solid rgb(var(--ring) / 0.55);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
}
```

---

## 10. Choices — RESOLVED (approved 2026-06-05)

1. **Fonts** — **Mono = IBM Plex Mono** + **Sans = General Sans** LOCKED (2026-06-05). **Display = Clash Display** LOCKED (2026-06-12) — chosen by seeing over Space Grotesk · Unbounded · Syne; used for every heading (hero, menu, section h2/h3).
2. **Loss red** — `#EF5350` kept (clinical, not warm coral — red marks the uncovered region as a mathematical reality, not an alarm).
3. **Radius** — crisp **8px** kept (4px reads harsh at scale; 12px breaks the quant feel).
4. **MM hue** — blue-violet `#8B7FF0` kept. **Accessibility rule:** on dense `/data` overlays where teal (pool) + violet (MM) sit together, never rely on hue alone — add a redundant non-color cue (line-style / marker / direct label) and verify against deuteranopia at build time.
5. **Mode** — **dark-only** at launch, confirmed. No light theme now.
