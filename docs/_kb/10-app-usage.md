# 10 — Using the Inflexion app (per-page user guides)

> Source material for the public docs + the founder's judge Q&A. Every technical
> claim is cited `file:line` against the live frontend in `apps/web`. The dApp is
> live on **Arbitrum Sepolia (chainId 421614)** against the fresh full redeploy of
> **2026-06-05**. All addresses load from `deployments/arbitrum-sepolia.json` via
> `@inflexion/sdk` — never hardcoded (`apps/web/README.md:58-60`).

---

## 0. Mental model before you touch the UI (the framing that is load-bearing)

Inflexion is a **collateralized bilateral derivatives market**, not "IL insurance."
An LP pays a **fixed upfront premium** to transfer the **in-range** impermanent-loss
risk of a *specific* Uniswap v3 position to an **underwriter** — either the **Path-A
pooled cvAMM vault** (the `ConvexityVault`) or a **Path-B market maker** — who posts
collateral and is paid for taking the risk. At expiry the protocol pays the LP their
realized IL, **capped at MaxIL**, trustlessly, from the underwriter's collateral.

Three facts the UI repeats on every risk surface, because they are load-bearing:

1. **It is an in-range convexity hedge.** Entry requires `Pa ≤ P0 ≤ Pb` —
   out-of-range positions are **rejected at creation**. The `/protect` empty-state
   says exactly this: *"Out-of-range positions are not protectable — entry requires
   Pa ≤ P0 ≤ Pb"* (`apps/web/app/(app)/protect/page.tsx:144-149`).
2. **Payout = `min(realized_IL, MaxIL)`.** The **cap is load-bearing** for the
   no-bad-debt guarantee. Surfaced verbatim across `/protect`, `/underwrite`,
   `/markets`, `/data` (e.g. `protect/page.tsx:71-73`, `underwrite/page.tsx:100-102`,
   `markets/page.tsx:190-193`).
3. **"No bad debt" is only true with the full qualifying clause.** The page copy
   states it as: *"In FULL mode the protocol cannot produce bad debt under its
   stated assumptions (capped payoff, solvent collateral, oracle & settlement
   liveness)"* (`protect/page.tsx:71-74`). Never claim it unqualified.

A fourth claim is **never merged** with the no-bad-debt claim, and is shown
prominently (not a footnote) anywhere a user supplies capital as an underwriter:
**depositor / MM capital is NOT guaranteed.** Junior is first-loss; senior is
protected from *underwriting* loss only, not the systemic tail (`earn/page.tsx:145-172`,
`underwrite/page.tsx:103-105`). The `/earn` disclosure is explicit that the
no-bad-debt guarantee *"is for the protected LP, not for you"* (`earn/page.tsx:163-165`).

**MaxIL is both the cap and the unit of risk.** It is pure geometry, frozen at
creation, identical across durations, and L-independent in the fair-rate sense —
which makes positions **fungible** to an underwriter within a market. That is why an
MM quote is **per-market** (a load + a MaxIL-ratio band + capacity), **never
per-NFT** (`underwrite/page.tsx:11-19`).

### The three pillars (what powers each page)

- **On-chain FairValue** — an exact closed-form Φ-sum from the Stylus
  `FairValueOracle` (`0x98a6aa75108b70fc0794bc3b87efe0ae99d5d52c`), **never
  reimplemented off-chain** (`INTEGRATION_MAP.md:21`). Drives every premium preview.
- **The cvAMM pool (Path A)** — always-on, signature-free underwriter
  (`ConvexityVault`, `0xDE2fFeBA2E6A18f3A53D43EC0fCCD299158eC30d`). Works without
  the engine.
- **MM competition (Path B)** — firm EIP-712 signed quotes, **no last-look**
  (`underwrite/page.tsx:98-99`). `createSwapRouted` gives the LP the cheaper of pool
  vs MM (`protect/page.tsx:5-6`).

### Numéraire and decimals (gets you in trouble if forgotten)

- **dUSDC = 6 decimals** is the numéraire — every premium, collateral, V0, MaxIL is
  6-dec raw (`1 dUSDC = 1_000_000n`) (`INTEGRATION_MAP.md:311`, `format.ts:5`,
  `format.ts:13-22`). `fmtUsd` divides by 1e6.
- **dWETH = 18 decimals** (the demo volatile token). Chainlink feeds are **8
  decimals** (e.g. the oracle price card renders `Number(price) / 1e8`,
  `underwrite/page.tsx:749`). WAD (1e18) is used for ratios (`σ_ref`, loads,
  regime bands) (`format.ts:44-52`).

---

## 1. Prerequisites — getting ready to use the app

### Wallet + network

- **Connect a wallet on Arbitrum Sepolia (chainId 421614).** Every dApp page gates
  its write actions behind a `ConnectGate`; reads work immediately, writes need a
  connected wallet (`README.md:41-43`, `protect/page.tsx:76`). RainbowKit + wagmi +
  viem is the stack (`FRONTEND_PLAN.md:26`). If `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`
  is unset the app still builds (placeholder id), but WalletConnect is non-functional
  (`INTEGRATION_MAP.md:80`).
- **Reads are graceful, never throwing.** Any read needing a reverting oracle, an
  absent rich event, or the not-yet-deployed subgraph returns a typed
  `{ available: false }` / `{ priceable: false }` envelope and renders an honest
  *pending* / *degraded* state — never an error (`INTEGRATION_MAP.md:5`).
- **Writes degrade, never crash at construction.** With no `walletClient`, LP/MM
  writes throw a clear error only when you click; DepositorClient returns
  `WriteResult { status:'deferred-no-wallet' }` so an external signer can take the
  unsigned tx (`INTEGRATION_MAP.md:317-318`).

### Demo tokens

- You need **dUSDC** (the numéraire, for premiums + collateral, address
  `0xB89630Dc6e020ae2A84aE72b7d9EEDBDfb2C544d`) and **dWETH** (the demo volatile
  token, `0xA8C07E1B245B346c5D1910c5055Efe67bF9E7D1D`) (`INTEGRATION_MAP.md:25-26`,
  `README.md:41-43`). These are the protocol's own **demo mocks** (a fresh
  numéraire-correct pair where `dWETH < dUSDC` so `token1 = dUSDC = numéraire`),
  distinct from Circle's testnet USDC / WETH (`deployments/arbitrum-sepolia.json:65-70`).
- To have an **eligible v3 position to protect**, you need a Uniswap v3 NFT on the
  seeded **dWETH/dUSDC** pool (`0xfE1Eb4D5796a350B13852F822B3E6a9fDbb858a5`, fee 500)
  that is currently **in range**. The deploy seeded a ~$100k unprotected demo LP
  (`tokenId 3218`) used for previews and the illustrative `/underwrite` pricing
  (`deployments/arbitrum-sepolia.json:66-73`).

### Optional backends (degradation is honest if absent)

| Service | Env var | If unset |
| --- | --- | --- |
| **Path-B engine** (MM quote relay) | `NEXT_PUBLIC_ENGINE_URL` | Path B unavailable → preview falls back to Path A only, `premiumB` undefined (`INTEGRATION_MAP.md:81`) |
| **Public REST API** (history) | `NEXT_PUBLIC_API_URL` | DataClient history surfaces return `{ available:false }` pending (`INTEGRATION_MAP.md:82`) |
| **RPC** | `NEXT_PUBLIC_RPC_URL` | no RPC; all reads fail at the transport layer (`INTEGRATION_MAP.md:79`) |

### The honest "pending" backdrop (true on every page today)

The **subgraph is not yet indexed** (events live on-chain since the deploy block
`274081134`, indexer pending). Anything historical/aggregate degrades to a typed
*pending* state, never a fake number or an error (`INTEGRATION_MAP.md:313`,
`README.md:54-55`). **Live today (RPC):** premium preview, payoff, buy/settle (Path
A), vault deposit/withdraw, market pricing, the current clearing-load surface,
σ_ref, the book (on-chain scan), coarse fills. **Pending the subgraph:** per-market
history/volume, NAV history, the time-series moat signals, precise MM fill
attribution (`README.md:46-55`).

---

## 2. `/protect` — LP buys in-range IL protection (claim A)

**Route:** `apps/web/app/(app)/protect/page.tsx`. **SDK:** `LpClient` (`lp.*`).
**Header copy** restates the whole product in two sentences including the qualified
no-bad-debt clause (`protect/page.tsx:69-74`).

### What the page shows (layout)

Two columns (`protect/page.tsx:118`): **left** = market picker + your eligible v3
positions; **right** = premium preview, payoff-with-cap chart, and the Buy panel.
Below both, full-width: **Your active protections** (`protect/page.tsx:184-186`).

### Step-by-step walkthrough

**Step 0 — connect.** Out of the `ConnectGate`: *"Connect a wallet on Arbitrum
Sepolia to view your positions and buy protection"* (`protect/page.tsx:76`).

**Step 1 — pick the market (fee tier × duration).** Two button rows derived from the
canonical `MARKETS` list: fee tiers **0.05% / 0.30% / 1.00%** and durations **7d /
30d / 90d** (`protect/page.tsx:51-56`, `lib/markets.ts:18-19`). Default is the demo
**fee-500 / 7d** market (`protect/page.tsx:89-91`). The selected `marketId` is shown
truncated under the picker (`protect/page.tsx:128-133`). `marketId =
keccak256(abi.encodePacked(dWETH, dUSDC, fee, durationSeconds))` (`lib/markets.ts:2-4,
21-28`).

**Step 2 — pick a position.** The left list calls `lp.listEligiblePositions(owner,
{ durations: [selectedDuration] })` (`protect/page.tsx:102-106`). It enumerates the
owner's NPM positions and computes geometry/MaxIL per position. Each row
(`PositionRow`, `protect/page.tsx:237-282`) shows:
- the **tokenId** (`#3218`);
- an **in-range badge** — teal "in range", amber "out of range", or "oracle
  degraded" when `inRange` is `undefined` (`protect/page.tsx:260-266`);
- **V0** (notional), **MaxIL** (the cap, in amber), and **L** (the stored liquidity)
  when priceable; otherwise a degraded reason (`protect/page.tsx:269-277`).
- If there are **no eligible positions**, the empty-state explains the in-range gate
  (`protect/page.tsx:144-149`).

**Step 3 — preview the premium.** `PreviewAndBuy` calls `lp.previewPremium(tokenId,
marketId)` and refetches every 30s (`protect/page.tsx:298-302`). The `PreviewResult`
carries `{ maxIL, fairPremium, fairRateWad, sigmaRefWad, premiumA, premiumB?, best,
path }` (`INTEGRATION_MAP.md:119`). The panel shows (`protect/page.tsx:343-366`):
- **Premium (best)** — what you pay once, with a Path A/B badge in the panel header
  (`protect/page.tsx:323-327`);
- **MaxIL (cap)** in amber;
- side-by-side **Path A · pool** vs **Path B · MM** (the MM cell shows "—" / *"no
  live MM quote"* when `premiumB` is undefined because the engine isn't running)
  (`protect/page.tsx:353-360`);
- **Fair premium** (the on-chain Φ-sum floor) and **σ_ref** (annualised vol)
  (`protect/page.tsx:361-364`).
- If the live oracle reverted (stale feed / sequencer down) the panel renders a
  `PendingNote`: not priceable now, the position still exists, becomes quotable when
  the oracle recovers — and **Buy is disabled** (`protect/page.tsx:336-341, 423-425`).

  *Why the two prices:* Path A is the mechanical pool floor; Path B is a competing
  firm MM quote. The route picks the cheaper. In the live lifecycle the MM beat the
  pool ($8.93 vs $13.80) and won the fill (`deployments/arbitrum-sepolia.json:92-104`).

**Step 4 — read the payoff-with-cap chart.** Rendered from the selected position's
geometry `{ pa, p0, pb }` (`protect/page.tsx:370-380`). The chart
(`components/charts/payoff-chart.tsx`) draws, in this exact visual language:
- **teal bold line** = payout you actually receive = `min(IL, MaxIL)`
  (`payoff-chart.tsx:87-95`);
- **teal shaded area** = the covered region (`payoff-chart.tsx:56-65`);
- **dashed red line** = the true IL, which keeps growing beyond the range
  (`payoff-chart.tsx:76-86`);
- **red shaded area** = the uncovered region (true IL above the cap; zero in-range)
  (`payoff-chart.tsx:66-75`);
- **amber dashed horizontal line labelled "MaxIL cap"** = the hero of the chart
  (`payoff-chart.tsx:119-146`);
- **vertical markers Pa / P0 / Pb** (`payoff-chart.tsx:97-117`).
  The caption: *"You are paid your realized IL up to MaxIL (teal) while the price is
  in range. Beyond the range the true IL (dashed red) keeps growing but your payout
  is capped at the amber line — the cap that makes the no-bad-debt guarantee hold"*
  (`protect/page.tsx:381-386`). The curve math is deterministic v3 geometry:
  `IL(P) = max(holdValue(P) − lpValue(P), 0)`, `MaxIL = max(IL(pa), IL(pb))`, all
  normalized to % of V0 (`lib/payoff.ts:50-75`). If geometry is unavailable the
  chart shows a degraded note instead (`protect/page.tsx:388-392`).

**Step 5 — buy (approve + createSwapRouted).** The Buy panel
(`protect/page.tsx:396-426`) states the deal in plain language: *"Pay $X now to
cover this position's in-range IL up to $MaxIL for {duration}"* and shows the
**max premium** sent with a **1% slippage buffer** (`SLIPPAGE_BPS = 100`,
`protect/page.tsx:49, 308, 401-405`). On click, `onBuy` calls
`lp.buyProtection({ tokenId, marketId, maxPremium, approve: true })`
(`protect/page.tsx:306-311`). The SDK **auto-approves**:
1. NPM `approve(core, tokenId)` — the position NFT;
2. dUSDC `approve(core.inflexionCore, maxPremium)` — spender is **InflexionCore**;
then sends `createSwapRouted` (default), which picks the cheaper of pool vs MM
(`INTEGRATION_MAP.md:308`, `protect/page.tsx:406-408`). Escape hatches exist
(`escapeHatch:'A'` → `createSwapPathA`, `'B'` → `createSwap`) but the default UI
always routes (`INTEGRATION_MAP.md:113`). The button uses `useTx` to show
signing → pending → success and surfaces errors trimmed to the first line
(`lib/use-tx.ts:43-73`). On success the eligible-positions, owner-swaps, and preview
queries invalidate so the new protection appears (`protect/page.tsx:312-316`).

**Step 6 — manage active protections + settle at expiry.** `ActiveProtections`
discovers the owner's swaps by an **on-chain scan** (no subgraph): it reads
`nextSwapId`, walks up to **200** swap ids, and keeps the ones where the protection's
`lp` matches the connected owner (`protect/page.tsx:438-457`). Each one renders an
`ActiveProtection` card (`components/protect/active-protection.tsx`):
- header with `swap #id`, an **Active / Settled** badge, and a **Path A · pool** vs
  **Path B · MM** badge (`isPathA = mm == convexityVault`)
  (`active-protection.tsx:48-56`, `INTEGRATION_MAP.md:119`);
- stats: **Premium paid**, **MaxIL cap** (amber), **V0**, and **IL to date** with the
  live `payout` and a "· capped" flag when the cap is hit
  (`active-protection.tsx:74-94`). IL-to-date is a `Priceable`; a degraded oracle
  renders a pending note, not an error — *"The protection is intact — payout is still
  computed at settlement from the price-at-expiry"* (`active-protection.tsx:96-103`).
- **Settle** appears only once the swap is **expired** (`secondsToExpiry === 0n`)
  and still active (`active-protection.tsx:33-36, 105-114`). Clicking calls
  `lp.settle(swapId)`, which recovers expiry, walks the Chainlink feed for the
  bracketing round if no hint is supplied, then calls `settle(swapId, hintRoundId)`
  (`INTEGRATION_MAP.md:116`). The caption: *"Pays your realized IL — capped at MaxIL
  — from the underwriter's collateral"* (`active-protection.tsx:110-112`). The whole
  list footer restates the qualified claim: *"LPs are always paid in FULL mode (no
  bad debt — qualified)"* (`protect/page.tsx:464-467`).

> **Live proof (already ran on-chain, 2026-06-05):** Path A swap #1 — V0 $270,531,
> MaxIL $1,669.24, premium $9.70 (**0.58% of MaxIL**), realized IL $148.64 paid in
> full from the ConvexityVault. Path B swap #2 — MM beat the pool ($8.93 vs $13.80),
> locked $3,215.65 of its own collateral, settled $245.66 from
> `UnderwriterVault` (`deployments/arbitrum-sepolia.json:81-105`).

---

## 3. `/earn` — depositor underwrites via the dual-tranche vault (claim B)

**Route:** `apps/web/app/(app)/earn/page.tsx`. **SDK:** `DepositorClient`
(`depositor.*`) over the live `ConvexityVault` (Path-A pooled underwriter). Defaults:
`vault = core.convexityVault`, `usdc = demoUsdc`, `sigmaToken = demoWeth`
(`INTEGRATION_MAP.md:123`).

### What the page shows + the prominent disclosure

The very first thing on the page — above everything, **not a footnote** — is the
**"Capital is NOT guaranteed"** panel (`earn/page.tsx:115-118, 145-172`). It spells
out: you are underwriting in-range IL; junior is first-loss; senior is protected from
*underwriting* loss only via the junior-first waterfall (`totalLocked ≤
juniorAssets`) — **not** from the systemic tail (USDC depeg, oracle/settlement
failure, contract bug); and the no-bad-debt guarantee is **for the LP, not for you**
(`earn/page.tsx:154-165`). It shows by default while vault state is loading
(`earn/page.tsx:117, 166-170`).

Layout (`earn/page.tsx:120-138`): left/center = **Vault overview** + **Tranche
split** + **NAV history**; right rail = **My position** + **Deposit** + **Withdraw**.

### Vault overview (pool-wide)

`depositor.getVaultState()`, refetched every 20s (`earn/page.tsx:81-85`). Shows
(`earn/page.tsx:196-227`):
- **Total assets** (dUSDC underwriting capital), **Locked** (backing open swaps,
  amber), **Free** (open capacity, fungible, teal), **Utilization** (locked / total);
- a regime badge — **calm / normal / stressed** (`earn/page.tsx:182-185, 68-72`);
- the load stack: **σ_ref**, **Concentration** (HHI colour), **Base load** (regime
  floor), **Total load** (the "price-to-beat", I10-clamped, teal). If the vol oracle
  is uninitialised / RPC degraded it renders a pending note (`earn/page.tsx:188-194`).

### Tranche split (the senior vs junior explainer)

Two cards (`earn/page.tsx:237-288`). The copy is load-bearing
(`earn/page.tsx:50-66`):
- **Senior** — *"Low-variance · underwriting-loss-protected."* Protected by the
  junior-first waterfall (`totalLocked ≤ juniorAssets`) from **underwriting loss
  only** — NOT from a systemic tail.
- **Junior** — *"First-loss · captures most of the premium."* Absorbs underwriting
  losses before senior is ever touched, in exchange for most of the premium yield;
  **junior withdrawals can revert `JuniorBelowLocked`** while collateral is locked.
Each card shows the tranche's assets and its **% of vault** (`earn/page.tsx:269-284`).

### My position

`depositor.getPosition(address)` (`earn/page.tsx:87-91`). Shows your **senior** and
**junior** rows: **Value (NAV)** = your shares converted to assets via
`convertToAssets`, **Shares**, and any **pending withdrawal** with a countdown
(`earn/page.tsx:341-373`). If you have no shares, an empty-state invites a deposit
(`earn/page.tsx:313-318`).

### Deposit

`DepositPanel` (`earn/page.tsx:377-439`). Pick a tranche (default **junior**),
type an amount, click **Deposit**. It calls `depositor.deposit(tranche, raw, {
autoApprove: true })` (`earn/page.tsx:386-392`). With auto-approve the SDK checks
`allowance` then sends dUSDC `approve(convexityVault, amount)` — **spender is the
ConvexityVault, not Core** (a common gotcha) — then `deposit(tranche, amount)`
(`INTEGRATION_MAP.md:309`, hint text `earn/page.tsx:417`). On success: *"Deposit
confirmed. Capital is NOT guaranteed."* (`earn/page.tsx:430-434`).

### Withdraw (request → cooldown → withdraw)

`WithdrawPanel` (`earn/page.tsx:443-568`). Withdrawals are **two-step and
cooldown-gated**:
1. **Step 1 — request:** `depositor.requestWithdrawal(tranche, shares)`
   (`earn/page.tsx:465-471`). A **Max** button fills the owned share balance
   (`earn/page.tsx:518`).
2. After the cooldown (`getWithdrawalCooldown`, shown inline, `earn/page.tsx:93-96,
   500-502`), **Step 2 — withdraw:** `depositor.withdraw(tranche)`
   (`earn/page.tsx:473-476`). The Step-2 button is disabled until
   `secondsRemaining === 0n` (`earn/page.tsx:462, 542-549`).
A pending banner shows queued shares + unlock countdown (`earn/page.tsx:533-538`).
The copy warns: *"A junior withdraw can revert `JuniorBelowLocked` if it would breach
senior protection"* (`earn/page.tsx:497-506`); the SDK surfaces that revert as an
error `WriteResult` (`INTEGRATION_MAP.md:138`).

### NAV history (honest pending)

`data.getNavHistory({ bucket: '1d' })` is subgraph/API-backed → always `ApiPending`
today; rendered as a `PendingNote` naming the future route, never faked
(`earn/page.tsx:99-102, 572-586`).

---

## 4. `/underwrite` — the Path-B market maker rail (claim B)

**Route:** `apps/web/app/(app)/underwrite/page.tsx`. **SDK:** `MmClient` (`mm.*`) +
engine. The page docstring is the canonical spec of the flow
(`underwrite/page.tsx:3-24`). Header: firm quotes, **no last-look**, you underwrite
the **capped** claim, **your capital is NOT guaranteed — you are short convexity and
paid the premium for it** (`underwrite/page.tsx:97-105`).

Three sections (`underwrite/page.tsx:107-111`): **collateral**, **quote builder**,
**book + fills**.

### 4.1 Post collateral (UnderwriterVault)

`CollateralPanel` (`underwrite/page.tsx:118-309`). Reads `mm.getMmCollateral(address)`
every 12s → **Deposited**, **Locked (== Σ MaxIL of your active fills, amber)**,
**Available to quote (teal)** (`underwrite/page.tsx:131-136, 223-238`). Invariant I5:
`locked ≤ deposited`.

Deposit/withdraw is a **separate, direct on-chain flow** — the SDK exposes the
ABI + addresses but **no MmClient helper for collateral**, so the page calls the
documented functions via the wallet client (it does **not** invent a method)
(`underwrite/page.tsx:8-11, 298-304`):
- **Deposit = two txs:** ERC-20 `approve(UnderwriterVault, amount)` (only if the
  allowance is short), then `UnderwriterVault.deposit(amount)`
  (`underwrite/page.tsx:154-183`). The hint warns: *"Collateral must stay instantly
  liquid — never lock it elsewhere"* (`underwrite/page.tsx:262-263`) — this is the
  spec rule that locked collateral must never be routed to utilization-gated venues.
- **Withdraw:** `UnderwriterVault.withdraw(amount)` — only **available** (un-locked)
  collateral is withdrawable (`underwrite/page.tsx:185-196, 264`).
A **Max** button fills wallet balance (deposit) or available collateral (withdraw)
(`underwrite/page.tsx:271-275`). The UnderwriterVault address
(`0x4Fb459F3393D206c2b7faD7f0fC9C35a78348D64`) is shown for transparency.

### 4.2 Build & sign a firm quote — PER-MARKET, NO tokenId

`QuoteBuilder` (`underwrite/page.tsx:313-838`). **This is the conceptual heart of
Path B.** A quote is **per-market**, not per-position: it fills **any in-range
position** in the market whose **MaxIL/V0 ∈ [min, max] bps** (MaxIL is the unit of
risk), up to capacity — InflexionCore checks the band at fill
(`underwrite/page.tsx:13-19, 574-579`). **There is no tokenId in a quote.**

**Inputs** (`underwrite/page.tsx:316-325, 559-647`):
| Field | Meaning | Notes |
| --- | --- | --- |
| **Market** | dropdown over all 9 markets | sets the `oracleToken` anchor (`underwrite/page.tsx:341-346`) |
| **Min / Max MaxIL ratio (bps)** | the MaxIL-ratio band = *which positions you cover* | `0 → 10000`; 10000 = cover all (`underwrite/page.tsx:581-589`) |
| **Your load (bps)** | your markup over the on-chain FairPremium | must be **≤ maxLoadBps (I10)** AND **strictly below the live pool load** (`underwrite/page.tsx:606-612`) |
| **Price band (bps)** | Fork-2 band around `quotePrice` | LPs fill only while the live price stays within ± this of the anchor (`underwrite/page.tsx:621-628, 751-754`) |
| **Max notional (V0)** | capacity cap for this quote (I7) | (`underwrite/page.tsx:632-638`) |
| **Valid for (s)** | validity window | on-chain bound to `now + [5,15]s` (`underwrite/page.tsx:639-646`) |

**Live reference cards (right side)** (`underwrite/page.tsx:670-823`):
- **Pool load to beat** — `mm.getPoolLoadToBeat(marketId)` every 8s; the headline
  bps you must undercut, broken into Base / Util skew / Disp skew, with the regime
  badge (`underwrite/page.tsx:390-395, 673-727`). Copy: *"Your load must be strictly
  below this and ≤ maxLoadBps (I10)"* (`underwrite/page.tsx:705-708`).
- **Oracle price — quotePrice anchor** — `OracleManager.getPrice(oracleToken)` every
  12s; the **Fork-2 band anchor you sign against**, position-independent. Signing is
  **blocked** if it can't be read (`underwrite/page.tsx:349-360, 729-757`).
- **Illustrative pricing** — uses the seeded demo LP (`tokenId 3218`) as a
  *representative* position via `mm.getPositionGeometry` + `mm.getMarketPricing`,
  showing sample MaxIL, on-chain FairPremium, pool premium, and est. premium at your
  load. The label is explicit that **the QUOTE does not depend on this — each LP is
  priced from their own position at fill** (`underwrite/page.tsx:362-387, 759-808`).
- **Representative payoff chart** (the same capped-payoff visual) with the caption:
  *"You pay the LP min(realized IL, MaxIL) at expiry... the cap is what keeps your
  downside bounded"* (`underwrite/page.tsx:810-822`).

**Guard banners** appear *before* you can sign: an I10 banner if `loadBps >
maxLoadBps`, and a "does not undercut the live pool" banner if `loadBps >= poolBps`
(*"A quote at or above the pool floor will not win the route"*)
(`underwrite/page.tsx:649-660`). The Sign button is gated on `canSign` = valid
inputs AND I10 OK AND below-pool AND connected (`underwrite/page.tsx:439, 662-666`).

**Signing (browser EIP-712, no private key in the browser)**
(`underwrite/page.tsx:441-513`): on click, the page **re-reads fresh** `maxLoadBps`
and pool load and re-enforces I10 + below-pool right before signing
(`underwrite/page.tsx:455-469`); reads the **fresh oracle price** for `quotePrice`
(`underwrite/page.tsx:471-478`); builds a `SignedQuote` (model `FULL=0`,
`partialRatioBps=0`, a random `quoteId`, a bitmap `nonce = encodeNonce(word, bit)`)
(`underwrite/page.tsx:480-496`); then `walletClient.signTypedData` with the domain
`{ 'Inflexion', '1', 421614, core.inflexionCore }`, `SignedQuoteTypes`, primaryType
`SignedQuote` (`underwrite/page.tsx:498-505`, domain/types
`INTEGRATION_MAP.md:200-227`). The 13-field struct order **must match**
`InflexionCore.SIGNED_QUOTE_TYPEHASH` exactly or the on-chain
`createSwap`/`createSwapRouted` rejects the signature (`INTEGRATION_MAP.md:198-227`).

**Publish** (`underwrite/page.tsx:515-539`): the signed envelope is POSTed to
`${NEXT_PUBLIC_ENGINE_URL}/quote` as a `QuoteWire` (bigints → decimal strings via
`encodeQuote`). If the engine URL isn't set, the page shows **"engine not
configured"** and renders the **exact wire envelope** the MM would hand the engine WS
(or an LP would pass to `lp.buyProtection`) in an expandable block
(`underwrite/page.tsx:847-913, 886-894`). The signed-envelope card prints loadBps,
band, quotePrice, maxNotionalV0, validUntil (local time), model (FULL/PARTIAL),
quoteId, nonce (`underwrite/page.tsx:872-884`).

### 4.3 Book, fills, cancel

`BookAndFills` (`underwrite/page.tsx:929-1076`):
- **Your book — active fills** via `mm.getBook(address)` every 15s. Shows **Exposure
  (Σ V0)** and **Locked (Σ MaxIL == your committed collateral, amber)**, plus a table
  of swap / V0 / MaxIL / premium / expiry (`underwrite/page.tsx:941-1033`). Discovery
  is an **on-chain swap scan** (no subgraph); aggregate exposure is exact
  (`underwrite/page.tsx:987-990`).
- **Cancel quote nonces** — paste space/comma-separated decimal nonces
  (`(word<<8)|bit`); `mm.cancelNonces(nonces)` **burns the bitmap bit so the quote can
  never fill** (`underwrite/page.tsx:1035-1064, 1038-1040`).
- **Recent fills** — `FillsFeed` via `mm.watchFills` (polls `SwapCreated` logs).
  **Attribution is coarse**: the event carries `mm` but **not** quoteId/nonce, so it
  cannot be joined to a specific signed quote; the badge says "coarse"
  (`underwrite/page.tsx:1069-1073`, `components/underwrite/fills-feed.tsx:3-6,
  117-121`). Precise per-quote attribution is the now-live `QuoteFilled` event,
  **pending the subgraph** (`INTEGRATION_MAP.md:95, 314`).

---

## 5. `/dashboard` — your portfolio across all three roles

**Route:** `apps/web/app/(app)/dashboard/page.tsx`. Aggregates **LP protections**,
**depositor deposits**, and the **MM book** for the connected user
(`dashboard/page.tsx:4-14`). Discovery is a **bounded on-chain swap scan of the last
`SCAN_LIMIT = 400` swaps** (no subgraph); every degraded envelope renders a
`PendingNote`, never an error (`dashboard/page.tsx:55-57, 89-131`).

- **(1) Protections (LP · claim A)** — scans `nextSwapId` downward, cheap-pre-filters
  raw `swaps(id)` by `lp == you` + non-zero status, then enriches with
  `getProtectionStatus` + `getClaimableFees` (`dashboard/page.tsx:86-132`). Each card
  has its own **Settle** button (`sdk.lp.settle(swapId)`)
  (`dashboard/page.tsx:217-240`). Section note restates the qualified no-bad-debt
  claim (`dashboard/page.tsx:181-184`). A pending note flags that full history + exact
  uncollected fees need the subgraph — `getClaimableFees` reads checkpointed
  `tokensOwed` only and **under-states** (`dashboard/page.tsx:185-188`,
  `INTEGRATION_MAP.md:315`).
- **(2) Deposits (depositor · claim B)** — `depositor.getPosition`; senior + junior
  cards with **Your NAV**, **Shares**, queued withdrawals, and inline
  **requestWithdrawal / withdraw** buttons (the junior card is badged **FIRST-LOSS**)
  (`dashboard/page.tsx:245-400`). Note restates capital-not-guaranteed
  (`dashboard/page.tsx:262-263`).
- **(3) MM Book (claim B)** — `mm.getBook` + `mm.getMmCollateral`. Collateral card
  shows **Deposited / Locked (I5: locked ≤ deposited) / Available**; the active-fills
  panel shows Σ V0 + Σ MaxIL exposure and per-swap rows
  (`dashboard/page.tsx:405-491`). Footer repeats the **coarse fill attribution**
  caveat and points to `/underwrite` to cancel nonces
  (`dashboard/page.tsx:480-485`).

---

## 6. `/markets` — action-oriented market browser (fully live)

**Route:** `apps/web/app/(app)/markets/page.tsx`. **Fully LIVE via RPC multicall, no
subgraph** (`markets/page.tsx:3-5`). Renders the **9 markets** (3 fee tiers × 3
durations) with their on-chain clearing load + fair premium.

- Header restates the in-range, capped-payoff framing and says the clearing load is
  *"the Path-A pool floor an MM must undercut to win the fill"*
  (`markets/page.tsx:188-194`).
- Summary stats: **Markets** (9 = 3×3), **Priceable now** (live oracle + σ_ref),
  **σ_ref (dWETH)** (EWMA reference vol), **Regime** (σ_ref vs load bands)
  (`markets/page.tsx:197-230`). All 9 markets share the **dWETH oracle / σ_ref**
  (`markets/page.tsx:153-159`).
- Each row: market label + truncated id, **σ_ref · regime**, **Clearing load**
  (price-to-beat), **Pool premium** with `fair … · cap …` sub-line, a **status badge**
  (live / paused / unregistered / oracle degraded), and **Protect** + **Underwrite**
  action links carrying the `marketId` query (`markets/page.tsx:42-134, 119-130`).
- Data: `data.getCurrentLoadSurface({ markets })` (one multicall, 15s refetch),
  `data.getSurfaceSigmaRef(demoWeth)`, and per-row `mm.getMarketConfig` for the active
  flag (`markets/page.tsx:143-178`). **Per-row degradation is inlined** — an
  unpriceable market shows a muted "—" with a reason badge ("unregistered" /
  "oracle degraded"), never dropped, never thrown (`markets/page.tsx:99-114`).
- The header right-side shows the **live block number** of the multicall
  (`markets/page.tsx:234-240`).
- **Honest pending footer:** per-market volume, MM win-rate / share, and the
  *historical* clearing-load surface need the subgraph; everything visible (clearing
  load, fair premium, σ_ref, regime) is live RPC right now (`markets/page.tsx:286-292`).

---

## 7. `/data` — the data-moat showcase (read-only, no wallet)

**Route:** `apps/web/app/(app)/data/page.tsx`. The public-alpha surface — *"the first
public view into the microstructure of the DeFi LP volatility-risk premium"*
(`data/page.tsx:3-4, 60-67`). No wallet, no writes (`data/page.tsx:17`).

**The honest split: 1 live, 4 structural-now / dynamic-with-volume.**

- **Signal 1 — Clearing-load surface (LIVE).** The hero: a fee × duration heat-matrix
  of pool load (bps over fair value) over a transparent σ_ref, read live via
  `getCurrentLoadSurface` + `getSurfaceSigmaRef` (30s refetch, with the live block
  number) (`data/page.tsx:36-115`). The grid (`components/data/load-surface-grid.tsx`)
  renders the 3×3 with heat colouring scaled to the hottest priceable cell; each cell
  shows `+N bps`, pool premium, regime, and the fair rate; degraded cells show "not
  registered" / "oracle degraded" honestly (`load-surface-grid.tsx:39-164`). This is
  the load **every Path-B MM must undercut** (`data/page.tsx:88-94`).
- **Signal 2 — Pool-vs-MM spread (pending).** Mechanical pool baseline vs behavioral
  MM load + win-rate; `getQuoteCompetition` (subgraph + engine COMPETITION_LOG)
  (`data/page.tsx:148-159`).
- **Signal 3 — Convexity term structure (pending).** Load slope across 7/30/90d at
  fixed width; `getLoadSurfaceHistory` (subgraph) (`data/page.tsx:161-174`).
- **Signal 4 — Demand skew (pending).** Realized fills vs latent interest; the latent
  half **never touches the chain by design (I7)** — it is off-chain engine telemetry;
  `getDemandRequests` (`data/page.tsx:176-187`).
- **Signal 5 — Net gamma (pending).** Total convexity the protocol is short (pool +
  every MM) + Σfree / Σlocked, computed off-chain over the open swap set;
  `getNetGamma` (`data/page.tsx:189-197`).
- **Pool NAV history (pending)** — the depositor-risk surface; carries the
  capital-NOT-guaranteed claim (`data/page.tsx:200-214`).

Each pending signal renders via `PendingHistory` → a `PendingNote` that prints
`env.detail` and **the exact future API route + query** it will be served from, from
the typed `ApiPending` envelope; never an error, never fabricated data
(`data/page.tsx:246-279`). The footer states the thesis — *"Structures from day one,
dynamics mature with volume"* — names the rich on-chain events already emitted since
the deploy (`SwapPriced`, `QuoteFilled`), and repeats both the capital-not-guaranteed
disclaimer and the capped/qualified no-bad-debt clause (`data/page.tsx:216-235`).

---

## 8. Cross-cutting UX you should describe consistently

- **Transaction states.** Every write uses `useTx`, which drives buttons through
  `signing → pending → success / error`, waits for the receipt, and trims viem's
  verbose revert dumps to the first line (`lib/use-tx.ts:31-76`).
- **Approvals + spenders (the recurring gotcha).** Premium → spender
  **InflexionCore**; depositor deposit → spender **ConvexityVault**; MM collateral →
  spender **UnderwriterVault**. They are three different spenders
  (`INTEGRATION_MAP.md:307-310`).
- **"Pending" ≠ "error."** Anything subgraph/oracle-backed that can't resolve renders
  a calm, typed pending/degraded state with the reason, often naming the route that
  will serve it once the subgraph deploys. This is a deliberate trust signal, not a
  bug (`INTEGRATION_MAP.md:313`, `README.md:54-55`).
- **CvammPricing is delegatecall-only.** The pool premium / load is computed
  client-side via the SDK's parity-locked **TS port** (`cvamm.*`), never by
  `eth_call`-ing the deployed library (`INTEGRATION_MAP.md:312`).

---

## 9. Quick reference — page → role → key SDK calls → live state

| Page | Role / claim | Key writes | Lives on (today) |
| --- | --- | --- | --- |
| `/protect` | LP / claim A | `buyProtection` (approve + `createSwapRouted`), `settle` | LIVE (Path A); Path B needs engine |
| `/earn` | Depositor / claim B | `deposit` (autoApprove → ConvexityVault), `requestWithdrawal`, `withdraw` | LIVE RPC; NAV history pending |
| `/underwrite` | MM / claim B | UnderwriterVault `approve`+`deposit`/`withdraw`, EIP-712 `signQuote`, `cancelNonces` | LIVE RPC + sign; publish needs engine; fills coarse |
| `/dashboard` | All | `settle`, `requestWithdrawal`/`withdraw`, (cancel on /underwrite) | LIVE on-chain scan (≤400 swaps); fees under-stated |
| `/markets` | Browse | none | FULLY LIVE RPC multicall; volume/share pending |
| `/data` | Data moat (read-only) | none | Signal 1 LIVE; Signals 2-5 + NAV pending |

---

### Honest "what's not there yet" (say it plainly to judges)

1. **Subgraph not indexed** → all history/time-series/aggregate surfaces are typed
   *pending*; events have been emitted on-chain since block 274081134.
2. **MM fill attribution is coarse** on-chain (`SwapCreated` has no quoteId/nonce;
   `isNonceUsed` can't distinguish fill from cancel) — precise attribution arrives
   with the `QuoteFilled`-indexing subgraph.
3. **Path B needs the engine running** (`NEXT_PUBLIC_ENGINE_URL`); without it,
   `/protect` previews Path A only and `/underwrite` signs but cannot publish (it
   shows the exact wire envelope instead).
4. **`getClaimableFees` under-states** (checkpointed `tokensOwed` only).
5. **No L2 Sequencer Uptime Feed on Arbitrum Sepolia** — `OracleManager` skips the
   sequencer check on testnet (`sequencerFeed == address(0)`); this must be set
   before any mainnet deploy (`deployments/arbitrum-sepolia.json:11-12`).
