# Inflexion frontend — plan & page map

> Status: **page map LOCKED** (2026-06-05). Design-token system is the current
> deliverable (`DESIGN_TOKENS.md`). **No pages built yet** — sketch-driven,
> human-in-the-loop: per-page wireframe → approve → build → checkpoint.

## Architecture

- **Split surfaces** (the legit-DeFi pattern):
  - `inflexion.xyz` — **marketing landing** (`/`). No wallet. Storytelling + the pitch.
  - `app.inflexion.xyz` — **the dApp** (`/protect`, `/earn`, `/underwrite`, `/dashboard`, `/markets`, `/data`). Wallet-connected.
  - `docs.inflexion.xyz` — **Mintlify** (`apps/docs`), separate, content is task #31.
- **Framework:** Next.js (App Router) + TypeScript.
- **Split implementation (sub-decision to confirm at scaffold time):** one Next app with route groups `(marketing)` + `(app)` and **domain-based middleware** mapping the two domains → one codebase, one shared design system, two deploy domains. (Alt: two separate Next apps. Defaulting to the single-app/route-group approach for deadline + shared tokens unless you prefer two apps.)
- **Consumes:** `@inflexion/sdk` via `workspace:*` (no npm publish needed) — surfaces map 1:1 to the SDK clients. Backend dependency: the hosted API + engine (task #30) for live writes/quotes; the subgraph (task #33) for history on `/markets` + `/data`. Landing + read/preview paths work without them.

## Stack (confirmed)

| Concern           | Choice                                              | Note                                                                            |
| ----------------- | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| Framework         | **Next.js App Router** + TS                         |                                                                                 |
| Styling           | **Tailwind, fully custom token system**             | the custom tokens are what kill the "AI look"                                   |
| Components        | **Radix primitives, styled by us**                  | **NOT stock shadcn**                                                            |
| Charts / data-viz | **visx** (+ lightweight-charts for any time series) | bespoke convexity / payoff-with-cap / load-surface — **data-viz IS the design** |
| Motion            | **Framer Motion**, restrained                       | respect `prefers-reduced-motion`                                                |
| Wallet            | **wagmi + viem + RainbowKit**                       | viem matches the SDK                                                            |
| Icons             | **Lucide** (1.5px stroke)                           | matches the hairline aesthetic                                                  |
| Fonts             | display + tabular-mono (see `DESIGN_TOKENS.md`)     | **not Inter-everywhere**                                                        |

**HARD CONSTRAINTS**

- **External libraries are welcome** (three.js, ReactBits, motion libs, etc.) — they're how you build a natural, polished site, not a constraint to avoid. The bar is **craft + identity, not avoidance**: never ship a prefab component in its default look — recolor + reshape it to the brand (e.g. the `FloatingLines` WebGL background recolored to teal and reshaped from a sine wave into the inflection **S-curve**). The bespoke data-viz still carries the brand alongside them.
- **Never touch** `settle` / `MaxIL` / `I1–I9` / `params.json` / `params.py`. The frontend is a read/write client only.
- **In-range coverage must be explicit** on every risk surface (see CHANGE 2 below).
- **Two-never-merged claims**, never blended, wherever risk is shown: (1) **LPs are always paid** — no bad debt in FULL, code-enforced; (2) **depositor / MM capital is NOT guaranteed** — they absorb crash losses up to MaxIL per position.

## Page map (7 pages)

### Marketing — `inflexion.xyz`

- **`/` — Landing.** The pitch (hedge Uniswap v3 in-range IL), the convexity motif (the `min(IL, MaxIL)` payoff-with-cap as hero visual), the three pillars (on-chain FairValue · cvAMM pool · MM competition), the three roles (Protect / Earn / Underwrite) as entry CTAs, live headline stats. Echoes the **capital-not-guaranteed** claim (never merged with the no-bad-debt claim).

### dApp — `app.inflexion.xyz`

- **`/protect` — LP buys protection.** Pick a v3 position (`NPM.positions`) → preview premium (on-chain FairValue + load) → **payoff-with-cap diagram** showing the **covered region (up to MaxIL, while in range)** vs the **uncovered region (beyond range, loss > cap)**, plain-language: _"covered while your position stays in range; capped at MaxIL beyond it."_ → buy (`createSwapRouted`) → active hedges + settle. SDK: `LpClient`.
- **`/earn` — Depositor underwrites (dual-tranche vault).** Senior vs junior, APYs, deposit/withdraw, NAV, the mirror of in-range coverage (they underwrite in-range IL **up to MaxIL**; max obligation per position = MaxIL → why FULL = no bad debt). **Prominent `CAPITAL IS NOT GUARANTEED` disclosure** (not a footnote modal) — they absorb crash losses up to MaxIL. SDK: `DepositorClient`.
- **`/underwrite` — MM (sophisticated).** Quote stream + the **"load to beat"** (pool price), post EIP-712 quotes, `UnderwriterVault` collateral (deposit/withdraw), fill history. Shows what they write = the in-range **capped** claim; locked collateral == MaxIL fully covers it in FULL. SDK: `MmClient`.
- **`/dashboard` — Your positions across roles** (protections / deposits / MM fills) + settle actions. SDK: all.
- **`/markets` — ACTION-oriented.** The 9 markets, per-market prices, where to buy / underwrite. SDK: `DataClient` + subgraph.
- **`/data` — THE MOAT SHOWCASE (data-signal-oriented).** The public alpha surface — _"free public data, exists nowhere else: the first view into the microstructure of the DeFi LP volatility-risk premium."_ The five signals:
  1. **Clearing-load surface over a transparent σ_ref**, bucketed by (width × distance-to-edge × duration). MM-leg load = the non-circular signal; pool load = the mechanical baseline. **Exclude `cappedAtMaxIL` fills.**
  2. **Pool-vs-MM load spread** (+ MM win-rate / depth) — forward-looking, cleanly non-circular; structural at launch, dynamic with ≥3 MMs.
  3. **Convexity term structure** — load slope across 7/30/90d tenors (behavioral slope in the MM `loadBps` leg).
  4. **Demand skew by moneyness** — realized (on-chain fills) now; latent/unfilled (engine/API telemetry) as it accrues.
  5. **Net gamma supply (protocol-wide)** — most launch-robust (a sum, informative day one).
     Honest framing: _structures from day one, dynamics mature with MM + flow volume._ Surface an API link. This is the **visual showpiece** — its bespoke curves ARE the brand motif. SDK: `DataClient` + subgraph. Echoes the capital-not-guaranteed claim.

> **Deferred (do NOT build/scaffold/mention now):** a documentation / how-it-works page — handled separately, later, as its own task.

## Design workflow (human-in-the-loop, sketch-driven)

1. **Design tokens first** (`DESIGN_TOKENS.md`) — colors, typography (display + tabular-mono), spacing, radius, shadows, motion. Locked before any page so every page shares one identity. ← **current deliverable; STOP for approval.**
2. **One page at a time.** Before coding: a **low-fi wireframe** (structure, hierarchy, where the curves/data-viz go, where the in-range/disclosure copy sits) → **STOP for review** (the human steers with an external design advisor; provides/approves a wireframe).
3. **Build only after the wireframe is approved**, then **checkpoint** before the next page. Iterate per feedback.

**Page order** (densest-signal / most-differentiating first, to establish the motif early):
`design tokens → / (landing) → /protect → /data → /earn → /underwrite → /markets → /dashboard`.

> One adjustment I'd suggest: the **payoff-with-cap chart** is a shared component used on `/` (hero), `/protect`, `/earn`, and `/underwrite`. I'll build it as a reusable visx component during the landing step so the core motif is consistent everywhere (not re-drawn per page).
