# 08 — The Data Moat: The Microstructure of the DeFi LP Volatility-Risk Premium

> **Source-of-truth note.** This KB entry is adjudicated against the LIVE Arbitrum
> Sepolia deployment (chainId 421614, `deployments/arbitrum-sepolia.json`, fresh
> full redeploy 2026-06-05) and the actual contract source in
> `packages/contracts/src`. Every technical claim cites `file:line`. The
> authoritative design docs are `spec.md` §10/§12, `docs/ACCESS_LAYER_ARCHITECTURE.md`
> §5, and `docs/ENGINE_TELEMETRY.md`. Where any of those disagreed with the live
> deployment, the deployment wins (per the Access-Layer doc's "Authority" clause,
> `docs/ACCESS_LAYER_ARCHITECTURE.md:55-58`).

---

## 0. The one-paragraph thesis

The order flow Inflexion generates is a byproduct that is itself a product: **the
first structured view into the microstructure of the DeFi LP volatility-risk
premium** (`spec.md:898`, `spec.md:22`). No venue today prices the *in-range
convexity of a specific Uniswap v3 range*. Inflexion does, on-chain, and every
fill records who paid what load over a transparent realized-vol reference, for
exactly which position geometry, at which maturity. The aggregate of those choices
is a dataset that **cannot exist anywhere else** because no other system is the
mechanism that creates it. The data is built passively from day one and exposed as
free public APIs (The Graph subgraph + REST) — **data is the moat, not a paywall;
revenue is protocol fees** (`spec.md:898`).

The honest framing — which MUST accompany any data-product pitch verbatim
(`docs/ACCESS_LAYER_ARCHITECTURE.md:350-359`):

> Inflexion is the **first venue that prices the in-range IL convexity of a
> SPECIFIC Uniswap v3 range**. The five signals below are the first structured view
> into the **microstructure of the DeFi LP volatility-risk premium**. At launch
> (1 MM, a handful of fills) we ship the **architecture and the static STRUCTURES**
> — the term-structure shape, the demand skew by geometry, the net-gamma surface.
> The full **DYNAMICS** (the pool-vs-MM spread as a forward-vol signal) require
> **multiple competing MMs** and mature **as volume grows**. We sell the
> architecture and the first view, not a mature dataset. Every signal surface
> carries this maturity disclaimer.

---

## 1. The central design problem: circular vs behavioral signals

The moat's credibility rests on **not being circular**. An earlier draft framed it
as "implied vol by inverting `fairRate`" — that is **DROPPED as circular**
(`spec.md:896`, `docs/ACCESS_LAYER_ARCHITECTURE.md:342-348`). The reason is
mechanical and worth stating precisely:

Every premium in the protocol is, by construction:

```
charged_premium / MaxIL = fairRate(σ_ref) · (1 + load)
```

`fairRate` is the protocol's own published closed form (the Φ-sum, computed by the
Stylus `FairValueOracle`), and `σ_ref` is the protocol's own published realized-vol
oracle. So **inverting `fairRate` from the charged premium recovers nothing but our
own published `σ_ref` plus our own dealer load stack** — it tells an outside
observer of our oracle exactly what they already knew. That is not a market-implied
vol; it is a tautology.

The fix: reframe the entire moat around **actor behavior** — the free CHOICES that
the protocol does *not* compute — measured AGAINST the transparent mechanical
baseline, never derived from it.

The non-circularity decision table (`docs/ACCESS_LAYER_ARCHITECTURE.md:364-369`):

| Source of the number                                 | Circular? | Why                                                                                                       |
| ---------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| MM-signed `quote.loadBps` (Path B)                   | **NO**    | An external actor's free choice; the protocol does not compute it. Capped only by `loadParams.maxLoadBps` (I10). |
| Which `tokenId` an LP brings + duration chosen       | **NO**    | LP demand choice; the protocol does not pick the geometry.                                               |
| Path-A pool load `totalLoadWad(σ_ref, util, conc)`   | **YES**   | Pure deterministic function of protocol state-machine outputs. Inverting it recovers our own formula. Keep as the **mechanical baseline / "price-to-beat"**, not a behavioral signal. |
| `fairRate(a, b, σ_ref, T)`                           | **YES**   | Our own published closed form.                                                                           |

**The rule (state verbatim, `docs/ACCESS_LAYER_ARCHITECTURE.md:371-373`):** a
signal is non-circular **iff** its informative degrees of freedom come from the
MM's `loadBps` or the LP's geometry/duration choice — measured AGAINST the
transparent mechanical baseline, not derived from it.

Two corollaries that fall out of this rule and recur in every signal below:

1. **The mechanical pool load is kept, but as a "price-to-beat" baseline, not as a
   signal.** Its job is to be the transparent yardstick the behavioral MM load is
   *subtracted from* (Signal 2's spread). The subtraction is precisely what removes
   the circular component.
2. **Cap-bound fills carry ZERO load information and MUST be excluded** from Signals
   1, 2, and 3. When `premium == MaxIL`, the load was truncated by the cap — the
   number you observe is the cap, not the actor's load. This is why the
   `SwapPriced` event carries an explicit `cappedAtMaxIL` boolean (see §3).

---

## 2. The behavioral context: what is "load", "σ_ref", and "geometry"

These three primitives recur throughout. Pin them down once.

### 2.1 The load stack (the price *above* fair value)

Every premium is `FairPremium · (1 + totalLoad)`, hard-capped at `MaxIL`. The
`totalLoad` is the dealer markup over the protocol's published fair value. On
**Path A (the cvAMM pool)** it is a deterministic, on-chain `pure` function of pool
state; on **Path B (an MM)** it is the MM's freely chosen `loadBps`.

The Path-A load stack, exactly as deployed
(`packages/contracts/src/libraries/CvammPricing.sol`):

```
totalLoad = clamp( baseLoad(σ_ref) + util_skew(util) + dispersion_skew(conc) ,  maxLoad )   ← I10
```

- **`baseLoad`** — a σ_ref **regime band only** (calm / normal / stressed), not a
  continuous function of σ_ref. `CvammPricing.baseLoadWad`
  (`CvammPricing.sol:47-55`): `σ_ref < regimeCalmBelowWad → baseLoadCalmBps`;
  `σ_ref ≥ regimeStressedAtWad → baseLoadStressedBps`; else `baseLoadNormalBps`.
- **`util_skew(u)`** — flat below a knee, convex above, capped
  (`CvammPricing.sol:58-67`): `0` if `u ≤ utilKneeWad`; else
  `min(utilCap, utilSlope · ((u−knee)/(1−knee))^utilPower)`. `u` = locked / total.
- **`dispersion_skew(h)`** — `min(dispCap, dispSlope · h^dispPower)`, `h` = the
  per-market coverage HHI (concentration) (`CvammPricing.sol:70-77`).
- **The I10 clamp** — `total = min(baseLoad + util + disp, maxLoadBps·1e14)`
  (`CvammPricing.sol:80-89`). This is invariant **I10 BY CONSTRUCTION**: the load
  sum is clamped so `premium ≤ FairPremium·(1 + maxLoad)` holds for ANY inputs, on
  BOTH paths, upstream of `settle` — it never touches `settle`/`MaxIL`/I1–I9
  (`CvammPricing.sol:12-17`).

**No load primitive is hardcoded** — every curve param comes from
`quant/params.json` (cvAMM block), mirrored on-chain by `InflexionCore.loadParams()`
(`CvammPricing.sol:9-11`, `CvammPricing.sol:25-44`). This matters for the moat: the
*mechanical* baseline is fully reproducible from public getters, which is exactly
what makes the *behavioral* MM load measurable against it.

**Critical term-structure subtlety:** the Path-A load stack is
**duration-INDEPENDENT by construction** — none of `baseLoadWad`, `utilSkewWad`,
`dispSkewWad` takes `durationSeconds` (`CvammPricing.sol:47-77`). All maturity
dependence lives in `fairRate(...,T)` (the σ_ref·√T closed form). So a Path-A "term
structure of load" is a *flat line*; the only behavioral term structure is the MM's
`loadBps` slope across 7/30/90d (Signal 3, §5.3).

### 2.2 σ_ref — the transparent realized-vol reference

`σ_ref = max(σ_short, σ_long, floor)`, a poke-based time-aware EWMA of
Chainlink-tick log-returns; **never** raw realized σ (`spec.md:957-958`,
`spec.md:43`). It is published on-chain via `VolOracle.sigmaRef(token)`. Because it
is transparent and on-chain, the load charged *above* it is a well-defined,
identifiable quantity — not a back-solved, non-identifiable "implied σ_LP". This is
the property that converts the moat from circular to legible (`spec.md:917-919`).

It is **backward-looking by design** — and the residual *forward*-looking premium is
deliberately left as MM alpha (`spec.md:820`, Inefficiency 4). That residual
blindness is the incentive that keeps MMs in the two-sided market, and it is exactly
what Signal 2 (the pool-vs-MM spread) extracts.

### 2.3 Geometry — the position the LP brings

Every behavioral signal is bucketed by **width × distance-to-edge × duration**:

- **width** = `log(Pb/Pa)` (tight vs wide range).
- **distance-to-edge** = `min(P0−Pa, Pb−P0) / P0` (centered vs near-edge).
- **duration** = `expiry − createdAt` (7d / 30d / 90d markets).

Geometry is recovered off-chain by decoding the swap's `tokenId` via
`NPM.positions(tokenId)` at the `SwapCreated` block (range ticks → Pa/Pb), plus
`expiry − createdAt` for duration (`docs/ACCESS_LAYER_ARCHITECTURE.md:410-412`,
`:694-698`). **No geometry is stored in any event** — the `NPM.positions` archive
decode is the one enrichment every geometry-bucketed signal (1, 3, 4) requires
(`docs/ACCESS_LAYER_ARCHITECTURE.md:694-698`).

`MaxIL` itself is the unit that makes positions *fungible* and the load
*range-agnostic*: premium is quoted as % of MaxIL, so MM/pool ROC is
range-independent and there is no adverse selection on range width
(`spec.md:47`). That is why an MM quote is per-MARKET (a load + a MaxIL-ratio band +
capacity), never per-NFT — and why bucketing the load by geometry is informative
rather than noisy.

---

## 3. The on-chain primitives — the two moat events + the breakdown library

The 2026-06-05 redeploy landed the two moat events and the on-chain load
decomposition. They are **LIVE on-chain now**; only the *subgraph that indexes them*
is pending (`packages/sdk/src/data.ts:30-35`, `:428-431`).

### 3.1 `SwapPriced` — the per-fill clearing-price record (mechanical baseline)

Emitted on ALL THREE create paths, at the end of `_executePathA` / `_executePathB`
(`InflexionCore.sol:262-272`, emit sites `InflexionCore.sol:671`, `:909`, `:952`,
`:1008`, `:1011`):

```solidity
event SwapPriced(
    uint256 indexed swapId,
    uint8   path,            // 0 = cvAMM pool (A), 1 = MM (B)
    uint256 fairPremium,     // the WAD baseline the load multiplies
    uint256 baseLoadWad,     // pool load decomposition (Path A); 0 on Path B
    uint256 utilSkewWad,     //   "
    uint256 dispSkewWad,     //   "
    uint256 totalLoadWad,    // Path A: clamped pool load; Path B: MM loadBps in WAD
    uint256 sigmaRefWad,     // the σ_ref the swap was priced against
    bool    cappedAtMaxIL    // true ⇒ premium hit the cap ⇒ ZERO load info
);
```

What it gives the moat (`docs/ACCESS_LAYER_ARCHITECTURE.md:382-398`):

- The **realized clearing-price baseline** + the **pool's mechanical load
  decomposition** + the **σ_ref** the swap was priced against, atomically, **with no
  archive `eth_call`** (the pre-redeploy design needed an archive `fairRate` call;
  that is no longer required for load — `docs/ACCESS_LAYER_ARCHITECTURE.md:699-703`).
- On a **Path-B fill**, the pool-load fields describe the **pool quote the MM beat**
  (the price-to-beat) — exactly what Signal 2's spread needs
  (`InflexionCore.sol:258-262`, `docs/ACCESS_LAYER_ARCHITECTURE.md:385-387`).
- `fairPremium` was added so the load can be normalised against the fair value
  (without it neither the pool's realized-load fraction nor the MM's load is
  normalisable — `docs/ACCESS_LAYER_ARCHITECTURE.md:390-394`).
- `cappedAtMaxIL` was added because deriving `premium == MaxIL` off-chain is brittle
  (rounding); the explicit flag removes the ambiguity and lets every consumer filter
  cap-bound fills cheaply (`docs/ACCESS_LAYER_ARCHITECTURE.md:395-398`).

The breakdown is assembled into a memory-only `SwapPricing` struct
(`InflexionCore.sol:561-572`) and emitted via the split-out `_emitPriced`
(`InflexionCore.sol:664-672`) so the 9-field event does not inflate the create
function's stack frames.

### 3.2 `QuoteFilled` — the single non-circular load datum (behavioral)

Emitted on every Path-B fill in `_executePathB` (`InflexionCore.sol:274-276`, emit
site `InflexionCore.sol:809`):

```solidity
event QuoteFilled(
    uint256 indexed swapId,
    address indexed mm,
    bytes32 indexed quoteId,
    uint256 nonce,
    uint16  loadBps          // the MM's actor-chosen load, attributed to the exact quote
);
```

This is **THE single non-circular load datum**
(`docs/ACCESS_LAYER_ARCHITECTURE.md:379-381`): the MM's freely chosen `loadBps`,
attributed to the exact quote/nonce. It is capped only by `loadParams.maxLoadBps`
(I10) — the protocol does not compute it. It also closes the pre-redeploy "coarse
fill attribution" gap (previously `SwapCreated`/`SwapRouted` carried no
`quoteId`/`nonce` and `isNonceUsed` was true on both fill AND cancel —
`docs/ACCESS_LAYER_ARCHITECTURE.md:44-49`, `:227`).

### 3.3 `CvammPricing.loadComponents` — the on-chain breakdown (delegatecall-only)

The pool load decomposition that feeds `SwapPriced` is computed on-chain by
`CvammPricing.loadComponents(σ_ref, util, conc, loadParams) →
(baseLoad, utilSkew, dispSkew, total)` (`CvammPricing.sol:98-110`), called from
`InflexionCore._pricePathAFromFair` (`InflexionCore.sol:626-642`, specifically
`:634-635`). The returned components are **PRE-clamp** (so `base+util+disp` may
exceed `total`); `total` is the I10-clamped sum (`CvammPricing.sol:96-97`).

**Load-bearing access detail for any client:** the deployed `CvammPricing` library
is **DELEGATECALL-ONLY** — a direct `eth_call` to it reverts (Solidity guards
deployed public-library functions; confirmed on the 2026-06-05 deploy). The lib runs
on-chain only via the core's delegatecall during pricing. Therefore the SDK
**PERMANENTLY** decomposes the two skews using a parity-locked TypeScript port
(`packages/sdk/src/math.ts` `loadComponents`), asserted byte-equal to the deployed
Solidity in `math.parity.test.ts` (`packages/sdk/src/data.ts:206-213`). This is the
only permitted duplication: the SDK NEVER reimplements the `fairRate` Φ-sum (read
from the on-chain `FairValueOracle`), but the load stack is an explicitly
deterministic `pure` transform of public inputs and may be re-evaluated client-side
(`docs/ACCESS_LAYER_ARCHITECTURE.md:62-65`, `:296-308`).

### 3.4 Existing events the moat relies on

(`docs/ACCESS_LAYER_ARCHITECTURE.md:556-562`)

- `SwapCreated(swapId, lp, mm, tokenId, V0, maxIL, premium)` — the open; carries the
  `tokenId` that the geometry decode keys off (`InflexionCore.sol:243-251`).
- `SwapSettled(swapId, realisedIL, payout, settlementPrice)` — closes the active set
  (Signal 5 open-set membership) (`InflexionCore.sol:252`).
- `SwapRouted(swapId, pathB, premiumA, premiumB)` — routed-only convenience carrying
  both candidate premiums; fires **only** from `createSwapRouted`, so it biases
  win-rate toward routed entries — which is why `SwapPriced` (emitted from all three
  paths) is the canonical per-fill pricing record, `SwapRouted` stays as a
  convenience (`InflexionCore.sol:253-257`, `docs/ACCESS_LAYER_ARCHITECTURE.md:431-440`).
- `VolOracle.Poked`/`Initialized` — the σ_ref series. Note `poke` is a **no-op
  emitting NO `Poked`** when `dt < minSampleInterval`, so the subgraph backfills
  σ_ref between pokes from `SwapPriced.sigmaRefWad` (emitted on every fill)
  (`docs/ACCESS_LAYER_ARCHITECTURE.md:558-562`, `:689-691`).

### 3.5 Why two signals can NEVER be on-chain (I7)

Two of the five signals need data that **never reaches the chain by design**: an
LP who priced but did not buy, and an MM quote that lost or was withdrawn, leave
**no on-chain trace** because invariant **I7** guarantees an *unchosen* quote
touches no nonce / no capacity (`docs/ENGINE_TELEMETRY.md:8-13`,
`docs/ACCESS_LAYER_ARCHITECTURE.md:507-510`). Putting unfilled interest on-chain
would both cost gas and break I7 (`docs/ACCESS_LAYER_ARCHITECTURE.md:532-533`). So
the *latent* half of Signal 4 and the *dynamic* half of Signal 2 live in **off-chain
engine telemetry** — captured from the very first interaction because they are
**unreconstructable retroactively** (`docs/ENGINE_TELEMETRY.md:3-13`). See §6.

---

## 4. The mechanical baseline vs the behavioral signal — the structure of every claim

Before the five signals, internalize the pattern they all share:

```
        BEHAVIORAL (the signal)              MECHANICAL (the baseline / price-to-beat)
        ───────────────────────              ─────────────────────────────────────────
Load:   QuoteFilled.loadBps  (Path B)   vs   SwapPriced.totalLoadWad  (Path A)
Vol:    the MM's forward view (implied)  vs   SwapPriced.sigmaRefWad   (backward EWMA)
Demand: which tokenId/duration LP picks  vs   (no mechanical counterpart — pure choice)
```

The **subtraction** (behavioral − mechanical) is what isolates the actor's view and
removes the circular component (`docs/ACCESS_LAYER_ARCHITECTURE.md:427-430`). Path A
is *never sold as a behavioral signal* — it is the transparent yardstick. Every
signal below either (a) reports the behavioral leg directly (Signal 1 Path-B load,
Signal 3 slope, Signal 4 demand), (b) reports the spread (Signal 2), or (c) is a
pure quantity that needs no de-circularization (Signal 5).

---

## 5. The FIVE behavioral signals — exhaustive

### Signal 1 — Realized clearing LOAD over a transparent σ_ref

*(bucketed by width × distance-to-edge × duration)*

**What it is.** The convexity risk premium charged *above* the published realized-vol
reference — the "convexity-premium index" / clearing load
(`docs/ACCESS_LAYER_ARCHITECTURE.md:400-403`, `spec.md:911-924`,
`spec.md:886-887`). Renamed from the old `getLPStructuralIV` (F-#12) precisely to
avoid the "IV" connotation (`spec.md:886`).

**Precise definition.** Per geometry bucket, the distribution of:
- POOL load = `SwapPriced.totalLoadWad` — the MECHANICAL load stack (the baseline).
- MM load = `QuoteFilled.loadBps` — the BEHAVIORAL actor choice (the real signal),
normalised against `SwapPriced.fairPremium` and `SwapPriced.sigmaRefWad` at each
fill.

**Why non-circular: PARTIAL — Path B only**
(`docs/ACCESS_LAYER_ARCHITECTURE.md:404-408`). The Path-B load (`QuoteFilled.loadBps`)
is an MM choice → **non-circular**. The Path-A load
(`SwapPriced.totalLoadWad = f(σ_ref, util, conc)`) is a deterministic function of
protocol state → **circular** (inverting it just recovers our own load stack). Keep
Path A as the mechanical baseline the MM is measured against; do **not** sell it as a
behavioral signal.

**Exclude cap-bound fills.** Filter `SwapPriced.cappedAtMaxIL == true` — a cap-bound
fill carries zero load info (the load was truncated by the cap)
(`docs/ACCESS_LAYER_ARCHITECTURE.md:413`).

**How it's sourced.** `QuoteFilled.loadBps` (the load) + `SwapPriced.sigmaRefWad` /
`fairPremium` (the baseline + reference vol) + `NPM.positions(tokenId)` at the
`SwapCreated` block (width / distance) + `expiry − createdAt` (duration). Subgraph
joins all on `swapId → tokenId` into the `BucketAggregate` entity
(`docs/ACCESS_LAYER_ARCHITECTURE.md:409-412`, `:667-672`). The CURRENT (non-historical)
load surface is served live by the SDK multicall (see §7).

**Maturity.** At 1 MM there is a single load point per bucket — **structural, not
dynamic** (`docs/ACCESS_LAYER_ARCHITECTURE.md:414-416`). Bucketed dispersion (the
spread across MMs' load views) needs **≥3 MMs** and ~30–50 fills/bucket to be a
regime — weeks-to-months at launch flow.

**Honest caveat (put in docs).** The load is CONTAMINATED by liquidity / SC-risk /
capital-lock / inventory-skew premia. **Trade the SPREAD (MM − pool, vs
implied/forward vol), not the level** (`spec.md:922-923`, `spec.md:939`).

---

### Signal 2 — Pool-vs-MM load SPREAD + MM win-rate / win-depth

**What it is.** The pool quotes a mechanical load; an MM undercuts when it has an
edge. The spread — plus how often and how deeply MMs beat the pool — is
**forward-vol expectation extracted from MM behavior**
(`docs/ACCESS_LAYER_ARCHITECTURE.md:418-423`). Aggressive undercut ⇒ market sees vol
cheaper than the backward-looking σ_ref ⇒ expects vol to fall; MMs retreat above the
pool ⇒ expects vol to rise. This is a VIX-like signal for LP markets
(`spec.md:926-931`).

**Precise definition.** Per bucket: `spread = poolLoad − mmLoad` (the subgraph `Swap`
entity stores `spreadWad = poolLoadWad − mmLoadBps`,
`docs/ACCESS_LAYER_ARCHITECTURE.md:663-665`); `win-rate = count(path==1)/count(all)`;
`win-depth = premiumA − premiumB`
(`docs/ACCESS_LAYER_ARCHITECTURE.md:440`).

**Why non-circular: YES — as a SPREAD**
(`docs/ACCESS_LAYER_ARCHITECTURE.md:425-430`). Each side is well-defined: pool load
(mechanical, `SwapPriced` on the Path-A candidate) and MM load (behavioral,
`QuoteFilled.loadBps`). The **difference** isolates the actor's view relative to the
transparent baseline — the subtraction is exactly what removes the circular
component.

**How it's sourced.** On a Path-B win, `SwapPriced` carries the **losing pool
quote's** `totalLoadWad` and `fairPremium`; `QuoteFilled.loadBps` carries the winning
MM load ⇒ the spread is in two joined events with no archive call
(`docs/ACCESS_LAYER_ARCHITECTURE.md:431-435`). The **dynamic half** (quotes that lost
or were withdrawn, how MMs widen/retreat under stress) is OFF-CHAIN engine telemetry
(`COMPETITION_LOG`, §6) — those quotes never touch the chain (I7). Subgraph entity:
`MarketMaker.cumulativeWinCount / cumulativeQuoteFillCount` for per-MM win-rate
(`docs/ACCESS_LAYER_ARCHITECTURE.md:683-684`).

**Maturity.** **Structural at launch; dynamic only with ≥3 MMs**
(`docs/ACCESS_LAYER_ARCHITECTURE.md:441-443`, `spec.md:903`). With one MM there is no
competitive distribution — you see one undercut, not a market view. Honest pitch:
"spread visible per fill; the forward-vol read matures with MM competition." Caveat:
at 1 MM the spread conflates "MM expects vol to fall" with "MM has cheaper hedges" —
two un-separable orthogonal drivers until competing MMs exist
(`docs/ACCESS_LAYER_ARCHITECTURE.md:428-430`).

---

### Signal 3 — TERM STRUCTURE of convexity (the slope across 7/30/90d per range)

**What it is.** The same position is protectable at 7/30/90d; how the load evolves
with maturity per range is the LP-convexity-premium term structure. **The slope is
the signal** (`docs/ACCESS_LAYER_ARCHITECTURE.md:445-448`).

**Precise definition.** For a fixed (width, distance) range, the curve of
`QuoteFilled.loadBps` across the three duration markets; its slope is the MM's term
view.

**Why non-circular: PARTIAL — and watch the subtlety**
(`docs/ACCESS_LAYER_ARCHITECTURE.md:449-457`). For **Path B**, the slope of
`QuoteFilled.loadBps` across durations is behavioral → non-circular. For **Path A**,
the load stack is **duration-INDEPENDENT by construction** — verified in
`CvammPricing`: `baseLoadWad` is a σ_ref-regime band only, `utilSkewWad`/`dispSkewWad`
depend only on inventory; none take `durationSeconds` (`CvammPricing.sol:47-77`). So
a Path-A "term structure of load" is a **flat line** (all maturity dependence lives
in `fairRate(...,T)`, our own σ_ref·√T). **Framing matters:** Path A gives the
*published `fairRate` term structure* (mechanical); Path B gives the *behavioral load
term structure*. Do not conflate (`spec.md:904`).

**How it's sourced.** `QuoteFilled.loadBps` per fill + duration (`expiry − createdAt`)
+ geometry (`NPM.positions`) bucketed by range; `SwapPriced.fairPremium`/`sigmaRefWad`
anchor each point; no archive call once `SwapPriced` lands
(`docs/ACCESS_LAYER_ARCHITECTURE.md:458-460`). Subgraph: the 7/30/90d rows of one
(width, distance) pair in `BucketAggregate` give the slope
(`docs/ACCESS_LAYER_ARCHITECTURE.md:670-672`). **Exclude cap-bound fills**
(`cappedAtMaxIL`).

**Maturity.** The **structure exists day one** (you can place 7/30/90d fills of one
range on one axis), but a clean slope needs ~30 fills per (range × duration) — at
1 MM, weeks per bucket. Structural at launch; slope-as-signal matures with volume
(`docs/ACCESS_LAYER_ARCHITECTURE.md:462-464`).

---

### Signal 4 — MONEYNESS / DEMAND SKEW by geometry

**What it is.** Which positions LPs seek to protect (tight vs wide; centered vs
near-edge) = LP-sentiment / leading-stress indicator. A surge in tight, near-edge
protection demand ⇒ LPs expect an imminent move
(`docs/ACCESS_LAYER_ARCHITECTURE.md:466-468`).

**Precise definition.** Per geometry bucket: the realized demand surface (fill count,
V0 volume) PLUS the latent demand (geometries priced/queried but not bought).

**Why non-circular: PARTIAL**
(`docs/ACCESS_LAYER_ARCHITECTURE.md:469-478`). **Realized** demand by geometry is an
LP choice (which `tokenId`/duration to bring) → non-circular for the fills we see.
But on-chain we observe **only realized purchases**, biased by quote availability (a
geometry queried 100× but filled 10× because it was too expensive reads as low
demand). **True demand including UNFILLED interest is OFF-CHAIN** — it lives in
relayer `/quote` requests and SDK `previewPremium` calls that never hit the chain.
On-chain gives the realized half; the latent half needs telemetry.

**How it's sourced.**
- *Realized:* `SwapCreated(swapId, lp, mm, tokenId, V0, …)` + `NPM.positions(tokenId)`
  + duration, aggregated per geometry bucket — fully on-chain, **no new event**, decode
  is subgraph work (subgraph entity `GeometryDemandBucket`:
  `realizedFillCount, realizedV0, firstSeen, lastSeen` —
  `docs/ACCESS_LAYER_ARCHITECTURE.md:479-482`, `:673-676`).
- *Latent:* OFF-CHAIN engine telemetry `DEMAND_LOG` — every `GET /quote` request and
  every `POST /telemetry/preview` ping, coarse-bucketed and PII-free (§6).

**Maturity.** Structural — the realized demand surface populates from the first
fills; the **leading-indicator** quality (surge detection) needs both volume AND the
off-chain request stream to separate demand from price-sensitivity
(`docs/ACCESS_LAYER_ARCHITECTURE.md:483-485`).

---

### Signal 5 — NET CONVEXITY / GAMMA SUPPLY (protocol-wide)

**What it is.** Total gamma being **sold** (pool + all MMs) and at what aggregate
load across the surface = a real-time gauge of DeFi appetite to sell vol; tradeable
vs Deribit (`docs/ACCESS_LAYER_ARCHITECTURE.md:487-490`, `spec.md:906`).

**Precise definition.** `Σ` over all ACTIVE swaps of per-swap gamma (from each swap's
stored geometry — the immutable `liquidity` / `amount{0,1}Entry` / ticks, invariant
I6) weighted by the realized load it was sold at (Path-B behavioral; Path-A
mechanical baseline). Plus `Σ free / Σ locked` and the demand rate per market.

**Why non-circular: YES — as a supply/quantity gauge**
(`docs/ACCESS_LAYER_ARCHITECTURE.md:491-499`). The aggregate is built from actor
positions; the **quantity** (how much convexity the protocol is short) is a
real-world fact, not a price computation. The per-swap **Greeks** are computed
off-chain by finite-differencing the deployed `ILMath.computeIL` /
`FairValueOracle.fairRate` (anchored to protocol math, no parallel model — §3.5 of
the Access-Layer doc / `GreeksEngine`).

**How it's sourced.** OFF-CHAIN compute over the subgraph-tracked open set
(`SwapCreated` opens, `SwapSettled` closes); the subgraph maintains the active-swap
set with each swap's geometry, the API/GreeksEngine sums Greeks over it — **not a new
event** (`docs/ACCESS_LAYER_ARCHITECTURE.md:500-503`). Subgraph entity:
`NetGammaSnapshot { activeSwapCount, totalV0, totalMaxIL, aggGammaWad, aggVegaWad,
volumeWeightedLoadWad }` (`docs/ACCESS_LAYER_ARCHITECTURE.md:677-680`); live counter
`ProtocolState` singleton (`docs/ACCESS_LAYER_ARCHITECTURE.md:608-611`).

**Maturity.** The gauge is **meaningful from a handful of swaps** (it is a sum, not a
distribution) — **the most launch-robust of the five**. It sharpens as the open book
grows (`docs/ACCESS_LAYER_ARCHITECTURE.md:504-505`).

---

## 6. The off-chain telemetry pipeline (Signals 2 & 4 dynamic/latent halves)

LIVE NOW — `packages/engine/src/telemetry.ts` (`TelemetrySink`) writes two
append-only JSONL sinks from the FIRST interaction, wired into `server.ts` and
exposed via `index.ts` env vars (`docs/ENGINE_TELEMETRY.md:26-35`,
`docs/ACCESS_LAYER_ARCHITECTURE.md:520-530`). The writer is **best-effort**: a
telemetry failure NEVER breaks a quote ack, preview, or `/quote` request
(`docs/ENGINE_TELEMETRY.md:29-31`). This data is **unreconstructable retroactively**
(I7) — capturing it now is the entire point (`docs/ENGINE_TELEMETRY.md:3-13`).

**`DEMAND_LOG` (Signal 4 latent half)** — written on every `GET /quote` and every
`POST /telemetry/preview` ping. Schema `DemandRecord`
(`docs/ENGINE_TELEMETRY.md:40-52`): `{ ts, marketId, widthBucket (tight|medium|wide|
full|unknown), distanceBucket (at-edge|near|mid|deep|unknown), durationBucket
(hour|day|week|month|longer|unknown), previewedPremium?, filled:false (ALWAYS — this
is the latent half), source (preview|quote-request) }`. **No PII, no raw geometry, no
tokenId, no addresses** — only coarse buckets + marketId; the SDK computes the buckets
client-side and POSTs only the labels (`docs/ENGINE_TELEMETRY.md:54-57`).

**`COMPETITION_LOG` (Signal 2 dynamic half)** — written for **every** inbound WS
quote, winners AND losers/stale/withdrawn-equivalent. Schema `CompetitionRecord`
(`docs/ENGINE_TELEMETRY.md:63-74`): `{ ts, marketId, mm, loadBps, validUntil,
accepted (true iff stored as a live candidate), reason? (present when accepted=false)
}`. Without this, `store.ts` keeps only the *latest* stored quote per (market, MM) —
the competing field (who else quoted, how wide, who widened/withdrew) is lost
(`docs/ENGINE_TELEMETRY.md:20`).

**SDK ping.** `LpClient.previewPremium` fires a best-effort, fire-and-forget
`POST ${engineBaseUrl}/telemetry/preview` that never blocks or fails the preview
(`docs/ENGINE_TELEMETRY.md:76-92`, `docs/ACCESS_LAYER_ARCHITECTURE.md:522-525`).
Engine `GET /health` reports sink status:
`{ telemetry: { demand: true, competition: true } }`
(`docs/ENGINE_TELEMETRY.md:104-106`). Env vars `DEMAND_LOG` / `COMPETITION_LOG` /
`QUOTE_LOG` set from the first deploy (`docs/ENGINE_TELEMETRY.md:96-102`).

This is a **structured log/telemetry pipeline, NOT a subgraph entity and NOT an
on-chain event** (`docs/ACCESS_LAYER_ARCHITECTURE.md:532-536`). Post-redeploy the API
reads these JSONL logs and serves `GET /data/demand-requests` (latent) and
`GET /data/quote-competition` (dynamic), each carrying the maturity disclaimer
(`docs/ENGINE_TELEMETRY.md:107-119`).

---

## 7. The access map — how a consumer reaches each signal

The three-layer routing rule, verbatim (`docs/ACCESS_LAYER_ARCHITECTURE.md:85-90`):

> **Needs to write, or needs the exact price right now → SDK.**
> **Needs history or an aggregate → Subgraph (consumed via the API).**
> **Needs frictionless public access with no wallet and no RPC key → API.**

The subgraph is **internal infrastructure** — nobody queries it directly in
production except the API (`docs/ACCESS_LAYER_ARCHITECTURE.md:99-104`). The API is a
thin, cached, read-only facade over the subgraph (+ a small set of cached live RPC
reads routed *through the SDK*, so pricing has exactly one implementation —
`docs/ACCESS_LAYER_ARCHITECTURE.md:752-755`).

### 7.1 Per-signal access table

| Signal | SDK method (`DataClient`)         | API route                       | Subgraph entity            | Live now?                                          |
| ------ | --------------------------------- | ------------------------------- | -------------------------- | ------------------------------------------------- |
| **1**  | `getCurrentLoadSurface` (LIVE, current); `getLoadSurfaceHistory` (history) | `GET /pool/load-surface` (current, live RPC); `GET /data/load-surface` (history); `GET /data/convexity-surface` (Signals 1&2 structural) | `MarketStateSnapshot`, `BucketAggregate` | **current = live RPC NOW**; history = subgraph-pending |
| **2**  | `getQuoteCompetition`             | `GET /data/quote-competition`   | `Swap.spreadWad`, `MarketMaker` win counts; + `COMPETITION_LOG` telemetry | **dynamic half = telemetry LIVE NOW**; structural = subgraph-pending |
| **3**  | (via `getLoadSurfaceHistory` / API) | `GET /data/term-structure?width&distance` | `BucketAggregate[]` across durations | subgraph-pending |
| **4**  | `getDemandRequests`               | `GET /data/demand-requests`     | `GeometryDemandBucket` (realized) + `DEMAND_LOG` telemetry (latent) | **latent half = telemetry LIVE NOW**; realized = subgraph-pending |
| **5**  | `getNetGamma`                     | `GET /data/net-gamma`, `GET /data/supply-depth` | `NetGammaSnapshot`, `ProtocolState` | subgraph-pending (off-chain Greeks compute) |

(SDK methods: `packages/sdk/src/data.ts` — `getCurrentLoadSurface:214`,
`getLoadSurfaceHistory:433`, `getQuoteCompetition:457`, `getDemandRequests:479`,
`getNetGamma:524`. The API-route strings are the SDK↔API contract, named in
`DATA_API_ROUTES`, `packages/sdk/src/data.ts:56-67`. API endpoint table:
`docs/ACCESS_LAYER_ARCHITECTURE.md:719-741`. Subgraph entities:
`docs/ACCESS_LAYER_ARCHITECTURE.md:652-692`.)

### 7.2 The one live SDK exception — `getCurrentLoadSurface`

The CURRENT pool load surface ("price-to-beat") is the only `DataClient` method that
hits live RPC instead of the API (`packages/sdk/src/data.ts:16-22`, `:185-213`). Per
market, one multicall over public getters:
`InflexionCore.markets(marketId)` → config; `FairValueOracle.fairPremium(token,a,b,T,
maxIL)` → `(premium, fairRate, σ_ref)`; `ConvexityVault.inventory()` →
`(total, locked, free, util, conc)`; `InflexionCore.loadParams()` (read once); then
the load stack is finished client-side via the parity-locked `CvammPricing` TS port
and `poolPremium = ceil(fairPremium·(1+totalLoad))` capped at MaxIL
(`packages/sdk/src/data.ts:196-213`, `:222-371`). Per-market graceful degradation: an
unknown/inactive market or a reverting oracle yields an inlined degraded `SurfaceRow`,
never a thrown call (`packages/sdk/src/data.ts:204-205`, `:300-314`, `:335-346`).
This is the **live half of Signal 1** (`spec.md:902`): the historical evolution of the
same surface is `getLoadSurfaceHistory` (API-backed).

### 7.3 Graceful degradation everywhere

Every API endpoint returns a discriminated union `{ available:true, … } |
{ available:false, reason, detail, query? }` and **never throws**; subgraph-backed
routes return a typed `pending` body (with the exact future GraphQL query embedded)
until `SUBGRAPH_URL` is set at the redeploy; the live RPC + telemetry routes return
real data NOW (`docs/ACCESS_LAYER_ARCHITECTURE.md:712-717`, `:762-771`). The SDK
mirror: history methods return a typed `ApiPending` naming the FUTURE route + the
query that would be sent, so wiring the API later is a one-line body swap
(`packages/sdk/src/data.ts:71-90`, `:530-548`).

---

## 8. State of the dataset (as of 2026-06-09)

- **On-chain moat events are LIVE.** `SwapPriced` / `QuoteFilled` and
  `CvammPricing.loadComponents` shipped in the fresh full redeploy **2026-06-05**
  (`deployments/arbitrum-sepolia.json:38-41`, `:48-64`). The redeploy block
  `274081134` is the subgraph `startBlock` — **the on-chain moat dataset begins
  here** (`deployments/arbitrum-sepolia.json:41`, `spec.md:908`).
- **The subgraph is built but NOT yet deployed** — it is CI-green offline
  (`graph codegen` + `tsc` + `vitest`) but `SUBGRAPH_URL` is unset, so every
  history/aggregate surface degrades to a typed `pending` state naming its future
  route (`docs/ACCESS_LAYER_ARCHITECTURE.md:6-11`, `:585-636`,
  `packages/sdk/src/data.ts:30-35`). This is the single real blocker for the
  HISTORY/AGGREGATE moat surfaces — a build gap, not a contract gap; the contracts
  emit every event needed (`docs/ACCESS_LAYER_ARCHITECTURE.md:783-786`).
- **The off-chain telemetry sinks are CAPTURING NOW** — `DEMAND_LOG` /
  `COMPETITION_LOG` from the first interaction; the SDK `previewPremium` ping fires
  now (`docs/ACCESS_LAYER_ARCHITECTURE.md:50-53`, `:520-530`).
- **One real subgraph gap** (when deployed): the **per-MARKET** dimension is declared
  but not yet populated (`SwapCreated`/`SwapPriced`/`QuoteFilled` carry no `marketId`;
  the handler does not yet derive it), so `Market` lifetime counters and
  `MarketStateSnapshot` stay zero-init. The **GEOMETRY-keyed** aggregates
  (`BucketAggregate` for Signals 1/2/3, `GeometryDemandBucket` for Signal 4) ARE
  fully populated, so the **geometry-bucketed moat signals are unaffected**. Closing
  it is a bounded follow-up: derive
  `marketId = keccak256(abi.encodePacked(token0, token1, fee, uint32(duration)))` in
  `handleSwapCreated` (`docs/ACCESS_LAYER_ARCHITECTURE.md:618-636`).
- **dUSDC = 6 decimals** is the numéraire; premiums and V0 in the live lifecycle are
  in USD (`deployments/arbitrum-sepolia.json:34`, `:78`). Sample fills demonstrating
  the load → moat path: Path-A swap #1 (premium $9.70 = 0.58% of MaxIL $1,669.24);
  Path-B swap #2 routed to the MM (`mmLoadBps = 1000`, premiumB $8.93 < cvAMM
  premiumA $13.80, settled from MM collateral) —
  `deployments/arbitrum-sepolia.json:77-106`.

---

## 9. Honest limits — put these in every data-product page

(`spec.md:939`, `docs/ACCESS_LAYER_ARCHITECTURE.md:350-359`,
`docs/ACCESS_LAYER_ARCHITECTURE.md:922-923`)

1. **The clearing load is CONTAMINATED** by liquidity + smart-contract risk premium +
   capital-lock cost + inventory skew. **Compare the spread (MM − pool), not the
   level.**
2. **The "invert fairRate for an implied-vol surface" claim is DROPPED as circular.**
   The signals are behavioral (MM `loadBps` + LP geometry/duration), measured against
   the mechanical baseline.
3. **Exclude cap-bound fills** (`SwapPriced.cappedAtMaxIL == true`) from the load
   surfaces — they carry zero load information.
4. **The signal is reflexive** as the protocol scales — normal for any derivative
   market.
5. **Calibration lags at launch** — there is no historical realized-IL dataset,
   because *the protocol is the mechanism that creates it. That is the data moat.*
6. **Structures day one, dynamics with volume.** We sell the architecture and the
   first view, not a mature dataset. The dynamic/latent halves (Signals 2 & 4) need
   day-one telemetry + ≥3 competing MMs; the on-chain halves of Signals 1/2/3/5 begin
   at the redeploy.
