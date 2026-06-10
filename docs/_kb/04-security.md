# 04 — Security, Invariants & Trust Model

> Source-of-truth knowledge dump for the public docs + judge Q&A. Every technical
> claim is cited to `file:line` against the deployed code on `main`. Anchor docs:
> `spec.md §13` (canonical invariant list), `docs/SECURITY.md`, `docs/MATH.md`,
> project-memory `inflexion-audit-findings`.
>
> **Reading order for a judge:** (1) the qualified no-bad-debt claim — never state it
> unqualified; (2) the ten invariants I1–I10 and *why* each holds; (3) the two
> resolved architectural forks; (4) the trust model (what the matcher can and cannot
> do). Everything else is supporting detail.

---

## 0. The headline security claim — stated correctly

**FULL mode cannot produce bad debt — but only under its full clause.** Say it
*with* the qualifier, every time:

> In FULL mode the protocol cannot produce bad debt **under its stated assumptions:
> (a) capped payoff, (b) a solvent collateral asset (USDC), (c) oracle/settlement
> liveness, and (d) no rehypothecation breach.**

Why each clause is load-bearing:

- **(a) Capped payoff** — coverage is `min(realized_IL, MaxIL)` and collateral = MaxIL,
  so `payout ≤ collateral` by construction. Remove the cap and beyond-range IL is
  *unbounded* (above `Pb` the LP is fully in token1 at constant value while hold value
  grows linearly with price), which no fixed collateral can back (`spec.md:172`,
  `spec.md:178`).
- **(b) Solvent USDC** — collateral, premium, and payout are all denominated in USDC
  (dUSDC, 6 decimals, the numéraire). A USDC depeg is a *disclosed shared risk*, not a
  protocol bug; the non-oracle token in every pair is assumed a USD-stable numéraire
  (`spec.md:19`, `InflexionCore.sol:1190-1193`).
- **(c) Oracle/settlement liveness** — settle pins the price to the Chainlink
  round-at-T. If the oracle never produces a usable round, funds can't settle. Fork-1
  (§5) bounds this with a liveness backstop so funds are never *permanently* locked.
- **(d) No rehypothecation breach** — locked collateral must stay instantly liquid;
  routing it to a utilization-gated venue (Aave/Compound) could make a withdrawal
  revert in a crash, breaking the guarantee. Only idle capital, only to
  instantly-redeemable wrappers (`docs/SECURITY.md:72`, CLAUDE.md hard rule).

**Two claims that must NEVER be merged** (`spec.md:26`, `ConvexityVault.sol:27-31`):

1. **LPs are always paid** — no bad debt, FULL, code-enforced (invariant I1). This is
   *structural and oracle-independent*: `settle` caps payout at `MaxIL == collateral`
   regardless of any pricing oracle.
2. **Depositors / MMs can lose principal** — the pool is a volatility *seller*;
   **capital is NOT guaranteed for either tranche.** Junior is first-loss; senior is
   structurally protected from *underwriting* loss only (never from systemic failure —
   USDC depeg, oracle failure, contract bug).

**The crucial split:** the no-bad-debt proof (I1) is *structural* (collateral = MaxIL ≥
payout) and *orthogonal to every pricing oracle*. The `FairValueOracle` and `VolOracle`
are load-bearing only for the **I10 price cap and depositor solvency**, **not** for the
FULL no-bad-debt invariant (`spec.md:43`, `spec.md:208`, `docs/SECURITY.md:320-325`).

---

## 1. The ten invariants — precise statement, why it holds, where enforced

All ten are from `spec.md §13` (`spec.md:1012-1031`). The settle-path set **I1–I9 is
KEEP-verbatim** from before the v4.0 hybrid pivot; **I10 is the new price cap**, added
*upstream of settle* and orthogonal to I1–I9.

### I1 — No bad debt (FULL): `payout ≤ collateral == MaxIL`

- **Why it holds:** `payout = min(realized_IL, MaxIL)` and `collateral == MaxIL` in FULL
  mode, so `payout ≤ MaxIL == collateral` for any price path. Structural, not
  heuristic — provable by Foundry invariant fuzz over the *whole* price domain
  (in-range, below `Pa`, above `Pb`, and the no-IL region).
- **Where enforced:** the payout cap in `settle` —
  `InflexionCore.sol:1099` (`uint128 payout = realisedIL > s.maxIL ? s.maxIL : uint128(realisedIL)`).
  The collateral was locked at MaxIL at creation (`InflexionCore.sol:736` Path A,
  `:787` Path B). Both vaults defensively re-check `payout ≤ lockedAmount`
  (`ConvexityVault.sol:309`, `UnderwriterVault.sol:170`).
- **Verified by:** `InflexionCore.invariants.t.sol::testFuzz_I1_I2_payoutCappedAtMaxIL`
  (256 runs, `:240`).

### I2 — Cap correctness: `payout == min(realized_IL, MaxIL)`

- **Why it holds:** same line — the ternary *is* the `min`. `realized_IL` is recomputed
  on-chain at settle from the Chainlink-pinned settlement price, never caller-supplied.
- **Where enforced:** `InflexionCore.sol:1094-1099` (`computeIL` then the cap). The
  settlement price `sqrtPTX96` is derived on-chain via `_oracleSqrtPriceX96` from the
  Chainlink round-at-T (`:1089`), *not* from calldata — closing the hole where a
  permissionless settler could otherwise set the payout anywhere in `[0, MaxIL]`
  (`docs/SECURITY.md:149-161`, design observation §3.4 there).
- **Verified by:** same fuzz test as I1.

### I3 — Non-negativity / no underflow

- **Statement:** `realized_IL = V_hold > V_lp ? V_hold − V_lp : 0` — *never* an unchecked
  subtraction. (Note: `assert(payout >= 0)` is vacuously true on `uint256`; the real
  content is that the subtraction is *guarded*, and the fuzzer drives `V_lp > V_hold`
  cases asserting no-revert + `payout == 0` — `spec.md:1014`.)
- **Why it holds:** the guarded ternary in the IL kernel.
- **Where enforced:** `ILMath.sol:97` (`return V_hold > V_lp ? V_hold - V_lp : 0; // I3: guarded subtraction`).
- **Verified by:** `ILMath.t.sol::testFuzz_I3_ilNonNegative` (256 runs, `:122`).

### I4 — LP never profits from the swap

- **Statement:** `V_lp ≥ V_hold ⟹ realized_IL == 0 ⟹ payout == 0`. The LP is made whole,
  never more — the swap is a hedge, not a lottery (`spec.md:1015`).
- **Why it holds:** same guarded clamp as I3 — when the LP would have profited vs hold,
  IL is zero, so the payout is zero. Settlement uses the oracle-pinned `P_T`, so the
  outcome reflects the true price, not a settler-chosen one (restoring I4 alongside I2 —
  `docs/SECURITY.md:160`).
- **Where enforced:** `ILMath.sol:97` (the `: 0` arm).
- **Verified by:** `ILMath.t.sol::test_il_atEntryIsZero` (`:44`) + the I3 fuzz; the
  invariant suite asserts `if (vLp >= vHold) payout == 0` (`spec.md:1028`).

### I5 — Vault solvency: `locked[mm] ≤ deposited[mm]` per MM (and per pool)

- **Why it holds (by construction):** `lockCollateral` requires
  `availableBalance(mm) = deposited − locked ≥ amount`, so post-lock `locked' ≤ deposited`;
  `releaseAndDistribute` requires `payout ≤ lockedAmount ≤ locked`, so `deposited' − locked' ≥ 0`
  (`UnderwriterVault.sol:14-20`).
- **Where enforced (Path B):** `UnderwriterVault.lockCollateral` (`:148-157`, the
  `avail < amount` revert) + `releaseAndDistribute` (`:164-185`).
  **Path A (pool):** `ConvexityVault.freeAssets() = totalAssets − totalLocked`
  (`:151-153`); `lockCollateral` requires `free ≥ amount` (`:289-290`). The pool analogue
  is `totalLocked ≤ juniorAssets ≤ totalAssets` (see I-extras below).
- **Verified by:** `InflexionCore.invariants.t.sol::invariant_I5_lockedLeDeposited`
  (`:500`) — SECURITY.md records **256 runs × 128,000 fuzzed vault-op calls × 0 reverts**
  (`docs/SECURITY.md:43`) — plus `UnderwriterVault.t.sol::testFuzz_I5_lockedNeverExceedsDeposited` (`:181`).

### I6 — Liquidity immutability: settle uses `L` stored at creation

- **Statement:** settlement computes IL with the `L` snapshotted at creation; an external
  `increaseLiquidity` on the custodied NFT cannot inflate `payout` above MaxIL
  (`spec.md:1017`).
- **Why it matters (attack F-#2):** the NFT is in protocol custody; if settle *re-read*
  `positions(tokenId).liquidity`, anyone could call `increaseLiquidity` post-creation to
  blow up the computed IL. Storing `L` once neutralizes this.
- **Where enforced:** `L` stored once at creation —
  `InflexionCore.sol:744` (Path A `liquidity: g.liquidity, // I6`), `:795` (Path B).
  Settle passes the **stored** `s.liquidity` to `computeIL` (`:1095`), never a re-read.
  `_prepareSwap` reads `liquidity` exactly once (`:603`, `// I6: stored once at creation`).
- **Verified by:** `InflexionCore.invariants.t.sol::testFuzz_I6_recordsStoredLiquidity`
  (`:316`) + `testFuzz_I6_settleUsesStoredLiquidity` (`:276`) + the end-to-end
  `ILVault.t.sol::testFuzz_F2_externalIncreaseLiquidity_arbitraryAmount` (`:164`, mutate
  on-chain `L` between create and settle, assert `payout` unchanged).

### I7 — Capacity authority: `consumedNotional[quoteId] ≤ maxNotionalV0`; a cancelled bit cannot fill

- **Statement:** the on-chain ledger is authoritative over the off-chain engine — a
  signed quote can fill repeatedly only up to its capacity, never after its nonce bit is
  cancelled, and concurrent submissions cannot over-consume (`spec.md:1018`). Path B only.
- **Why it holds:** check-and-increment is **atomic in one transaction, in PHASE 3
  effects, before any external call** —
  `InflexionCore.sol:897-899` (the `consumedNotional[quoteId] + g.V0 > maxNotionalV0`
  revert in PHASE 2) and the atomic `consumedNotional[quote.quoteId] += g.V0`
  + `_useNonce(...)` in `_executePathB` (`:776-777`). `capacity` is denominated in **V0
  (position value)**, not collateral (`spec.md:361`). Nonces are a **Permit2-style
  bitmap** (`nonce = word<<8 | bit`) so an MM cancels *one* quote by flipping *one* bit —
  never cancel-all (`InflexionCore.sol:445-478`, `cancelNonces` / `_useNonce` /
  `isNonceUsed`).
- **Router subtlety (also I7):** in `createSwapRouted`, **only the executed rail mutates
  nonce/capacity/lock.** The router's Path-B usability predicate `_quoteUsableAndPremiumB`
  is `view` — it *reads* `isNonceUsed`/`consumedNotional` but never calls `_useNonce`
  (`InflexionCore.sol:674-715`, esp. the `// READ only — never _useNonce` at `:698`). A
  quote that loses the route consumes nothing.
- **Where enforced:** `InflexionCore.sol:776-777` (mutation), `:897-899` (capacity
  check), `:469-478` (`_useNonce`).
- **Verified by:** `InflexionCore.t.sol::test_createSwap_consumedNotional_tracked` (`:446`)
  + `test_createSwap_rejectsUsedNonce` (`:407`). Full handler-driven stateful fuzz is
  deferred to post-mainnet (`docs/SECURITY.md:45`).

### I8 — Settlement liveness (Fork-1 fix): `settle()` always succeeds within the window

- **Statement:** for any swap, under any price path, `settle()` succeeds by
  `expiry + LIVENESS_WINDOW + MAX_STALENESS + GRACE_PERIOD` — the lone-spike check never
  permanently locks funds (`spec.md:1019`).
- **Constants:** `GRACE_PERIOD = 3600`, `LIVENESS_WINDOW = 86_400` (24h),
  `LONE_SPIKE_BPS = 500` (5%) (`OracleManager.sol:22-30`); `MAX_STALENESS` is per-token,
  Sepolia value 90,000s (`deployments/arbitrum-sepolia.json:18`).
- **Why it holds:** settle pins the Chainlink round-at-T (unique, bracketed below by
  `updatedAt ≤ expiry`). A *glitched* print (a "lone spike" differing from **both**
  neighbours by ≥ `LONE_SPIKE_BPS`) is deferred — but only until
  `block.timestamp ≥ expiry + LIVENESS_WINDOW`, after which the backstop accepts the round
  *unconditionally* (`OracleManager.sol:266` `backstop`, `:291-298`). A missing neighbour
  round across a Chainlink `phaseId` boundary is read **tolerantly** via `_tryRound`
  (try/catch returning `ok=false` instead of reverting, `:322-331`), so it degrades to
  the backstop rather than a permanent lock (`:301-307`).
- **Where enforced:** `OracleManager.getSettlementPrice` (`:237-315`).
- **Verified by:** `OracleManager.invariant.t.sol` — 5 fuzz tests, ~1,280 runs:
  `testFuzz_I8_settleSucceedsAnywhereInBackstopWindow` (`:55`),
  `testFuzz_I8_sustainedMoveSettlesImmediately` (`:113`),
  `testFuzz_I8_loneSpikeDefersBeforeBackstop` (`:132`),
  `testFuzz_I8_sequencerRecoveryRespectsGrace` (`:157`),
  `test_I8_revertsPastStaleness_boundary` (`:95`).
- **⚠ Documented design observation (NOT a bug):** the *spec-literal* staleness `require`
  fires *before* the backstop can recover the round, so the **actual usable window is
  `[expiry + LIVENESS_WINDOW, expiry + MAX_STALENESS)` ≈ 1 hour wide** (90,000 − 86,400 =
  3,600s), not the full additive sum the I8 wording suggests. Past `expiry + MAX_STALENESS`
  the round-at-T is "stale"; funds can still settle via a *newer* Chainlink round
  (Arbitrum majors tick frequently), just not via the round-at-T. The 1h window is
  *symmetric* for LP and MM (preserves fairness). Surfaced in NatSpec at
  `OracleManager.sol:219-236` and the boundary test, not papered over
  (`docs/SECURITY.md:83-112`).

### I9 — Oracle-anchored band (Fork-2 fix): `createSwap` reverts iff `absBps(P_live, quotePrice) > priceBandBps`

- **Statement:** a Path-B signed quote auto-voids on-chain, deterministically, iff the
  live oracle has drifted beyond the MM's chosen band — *not* last-look (`spec.md:1020`).
  Path A has no signed quote, so it has no such vector (it prices off the live oracle
  directly).
- **Bounds:** `PRICE_BAND_MIN_BPS = 25` (0.25%), `PRICE_BAND_MAX_BPS = 500` (5%), MM
  default 100 (1%) (`InflexionCore.sol:85-86`, `spec.md:377-381`).
- **Why it holds:** at `createSwap`, the contract reads the live oracle price
  *once* (the same read that pins `P0` — zero extra oracle cost, carried as `g.livePrice`)
  and checks `absBps(P_live, quote.quotePrice) ≤ quote.priceBandBps`. Beyond the band ⇒
  revert. Deterministic, no MM discretion at fill ⇒ not last-look. The MM is exposed only
  to drifts *within* the band it chose (it priced for them), never to gaps that blow
  through it.
- **Where enforced:** `InflexionCore.sol:887-895` (PHASE 2 band check;
  `bandDevBps = oracle.absBps(g.livePrice, quote.quotePrice)` then revert
  `PriceOutOfBand`). `absBps` is the pure helper at `OracleManager.sol:169-179`. The
  single live read is in `_prepareSwap` (`:597` `g.livePrice = oracle.getPrice(...)`). The
  router mirrors this as a non-reverting boolean (`:704-707`).
- **Verified by:** `InflexionCore.invariants.t.sol::testFuzz_I9_priceBandViolationReverts`
  (`:338`) + `testFuzz_I9_priceBandWithinBandAccepts` (`:359`), 256 runs each, both
  directions.

### I10 — Price cap (LAUNCH; **by construction**; upstream of settle): `premium ≤ FairPremium · (1 + maxLoadBps)`

- **Statement:** on **both** paths the charged premium can never exceed
  `FairPremium · (1 + maxLoadBps)`. Overcharge is impossible *by code*, not by trust
  (`spec.md:1021`).
- **Why it holds (Path A):** the load sum is a **mechanical, deterministic clamp** —
  `total = min(baseLoad + util_skew + dispersion_skew, maxLoad)` — so the premium ceiling
  holds for **all sequences of states and all price paths** (FULL and PARTIAL both), with
  no MM discretion and no graceful-degradation path.
  `CvammPricing.totalLoadWad` (`:80-89`) and `loadComponents` (`:98-110`) both apply the
  `total > maxLoad ? maxLoad : total` clamp; `premiumFromLoad` then computes
  `ceil(FairPremium·(1+total))` (`:113-118`). Wired in `_pricePathAFromFair`
  (`InflexionCore.sol:626-642`).
- **Why it holds (Path B):** premium is **derived from the on-chain FairPremium**, not
  streamed raw — `premium = ceil(FairPremium·(1 + loadBps/1e4))` with a hard
  `require(loadBps ≤ maxLoadBps)`. The quote can only set a *load over the published fair
  value*, not the premium itself (`InflexionCore.sol:855-860`; the
  `LoadExceedsMax` revert at `:855-857`; `_pricePathB` at `:647-662`).
- **Orthogonality (state this in Q&A):** I10 lives in **PHASE 1 (pricing, READ)**,
  strictly **upstream of `settle`**. It does **NOT** touch `settle`, the MaxIL formula, or
  I1–I9. The no-bad-debt proof (I1) is structural (collateral = MaxIL ≥ payout) and is
  *always* true by code, while I1 additionally depends on oracle/settlement liveness; I10
  is *always* true by code with no liveness dependency. Neither the senior/junior premium
  split nor the `totalLocked ≤ juniorAssets` constraint affects I10 or settle semantics
  (`spec.md:1021`, `CvammPricing.sol:12-17`).
- **Both paths also cap premium at MaxIL** (never charge more than the max possible
  payout): `InflexionCore.sol:637-640` (Path A), `:657-660` (Path B).
- **Verified by:** `CvammPricing.t.sol::testFuzz_I10_clamp` (`:64`) +
  `InflexionCore.invariants.t.sol` asserts `charged ≤ fairPremium·(1e4 + maxLoadBps)/1e4`
  (`spec.md:1031`, `docs/SECURITY.md:48`).

### Pool-side structural invariant (the senior-protection guarantee, distinct from I5)

Not numbered I1–I10 but central to the trust story (`ConvexityVault.sol:16-25`):

- **`totalLocked ≤ juniorAssets`** is enforced at **every** `lockCollateral`
  (`ConvexityVault.sol:291-293`, the `SeniorProtectionBreached` revert). Since every
  payout `≤` its MaxIL `=` its locked amount, total payouts `≤ totalLocked ≤ juniorAssets`,
  so the **junior-first-loss waterfall absorbs all underwriting loss before senior is ever
  touched.** The waterfall in `releaseAndDistribute` takes `juniorLoss = min(payout, juniorAssets)`
  first, `seniorLoss = payout − juniorLoss` only after (`:321-328`); by the invariant the
  `min` is defense-in-depth (senior is never reached).
- This is the **adaptive code form** of the ROADMAP's `u ≤ 1−sf` rule, keyed to the
  *actual* junior buffer (safer than a fixed ratio). `sf = 0.60` (P1.13) is the *target*
  tranche ratio for UX/incentives, **not** the hard cap (`ConvexityVault.sol:23-25`).
  Senior `P(loss)=0` is a *calibration* result (holds while `u ≤ 1−sf`), **not** a
  structural guarantee — capital-not-guaranteed remains the umbrella for both tranches
  (`spec.md:110`).
- **Run defense:** withdrawals are cooldown-gated (`requestWithdrawal` → `withdraw` after
  `withdrawalCooldown`, `:222-265`) and **junior cannot be withdrawn below `totalLocked`**
  (`:257`, the `JuniorBelowLocked` revert). The same locked/free accounting that prevents
  a run also drives `util_skew` *up* before the pool over-commits.

---

## 2. Settlement-path math (why I1–I4 are true at the formula level)

From `spec.md §3.1–§3.2` (`spec.md:138-178`); contract is `ILMath.sol`.

- **IL definition** (numéraire = token1, typically USDC):
  `realized_IL = max(0, V_hold(P_T) − V_lp(P_T))` where `V_hold` is the entry amounts held
  passively and `V_lp` is the position's value at the settlement price across three regimes
  (in-range, fully token0 below `Pa`, fully token1 above `Pb`) — `ILMath.sol:87-119`.
- **MaxIL = the collateral unit and the cap.** `IL(P)` is **convex on `[Pa, Pb]`**
  (`V_hold` affine, `V_lp` strictly concave since `d²V_lp/dP² = −¼·L·P^(−3/2) < 0`), so its
  maximum *while in range* is at a boundary: `MaxIL = max(IL(Pa), IL(Pb))`
  (`spec.md:164-170`, `ILMath.computeMaxIL:37-52`). Two external auditors flagged this;
  one re-derived and confirmed it (`spec.md:166`).
- **MaxIL is pure geometry, frozen at creation, identical across the three durations**
  (7/30/90d) for a given position — duration moves only `fairRate`, never MaxIL
  (`spec.md:97`, `spec.md:191`). This makes positions **fungible to an underwriter within
  a market**: an MM quote is **per-market** (a load + a MaxIL-ratio band + capacity),
  **never per-NFT**.
- **Reference magnitudes** (geometric-symmetric range, verified from `il.py`):
  `±5% → 1.27%` of V0, `±10% → 2.56%`, `±20% → 5.23%`, `±50% → 13.76%` (`spec.md:185-188`).
- **`r = 0` / zero-drift assumption** — the only residual approximation in fair value is
  the GBM forward pinned at `F = P0` (martingale, `r = q = 0`). A nonzero carry tilts the
  true forward; sized and found economically negligible at launch scope (worst absolute
  move +0.32 pts of MaxIL; a $50k/±10%/30d position moves ≤ $1.30 even at `θ = −0.08`, at
  or below the $1 dust floor). Acceptable for the buildathon; revisit for long-dated
  (≥90d) or high-carry pairs (`docs/SECURITY.md:185-203`).

---

## 3. Entry/settlement price pinning — the closed trust hole (vNEXT fix)

A review found `createSwap`/`settle` once accepted a **caller-supplied** sqrt price:
`settle` computed payout from the caller's `sqrtP_T`, so any permissionless settler could
set the payout anywhere in `[0, MaxIL]`; `createSwap` let an LP pick the entry that sets
MaxIL/premium/V0 (`docs/SECURITY.md:149-161`).

**Fix (now in code):** both prices are **derived on-chain from Chainlink** via
`_oracleSqrtPriceX96` (`InflexionCore.sol:1200-1207`, delegating to
`SwapMath.oracleSqrtPriceX96`), decimal- and orientation-aware. `MarketConfig` decimals
are read **on-chain at `registerMarket`** (`:370-372`), never trusted from calldata — a
single wrong digit would mis-scale every price ~10×. The oracle orientation is **immutable
across re-registration** (`:361-364`, `MarketPriceConfigImmutable`), so re-registering a
market can never re-price an already-active swap. This restores **I2/I4** and the Fork-1
oracle pinning. Accepted residuals by design:

- **In-range is defined at the ORACLE price, not the pool's `slot0`** — the `Pa ≤ P0 ≤ Pb`
  gate compares the Chainlink-derived `P0` (`:600-602`). Consistent with
  (oracle-pinned) settlement; not a fund-loss vector.
- **Bounded entry-timing freedom** — `P0` is the latest Chainlink round at the LP's chosen
  block, clamped to within `priceBandBps` of the MM `quotePrice` over a 5–15s window
  (I9). Bounded and blunted by premium scaling with MaxIL — intended firm-quote design,
  not a drain.

**LP-lies-about-geometry defense:** `sqrtPa`/`sqrtPb` are derived on-chain from
`positions(tokenId).tickLower/tickUpper` via TickMath (`InflexionCore.sol:593-594`,
`_sqrtBoundsFor:1125-1132`); the position's actual `(token0, token1, fee)` is cross-checked
against the registered `marketId` (`:590-591`, `MarketMismatch`). An LP can lie about
neither the range nor the entry price.

---

## 4. The CEI / 4-phase ordering on `createSwap` (reentrancy + atomicity)

Every create path follows the spec §5.2 four-phase Checks-Effects-Interactions structure
(`InflexionCore.sol:827-1014`):

- **PHASE 1 — READ** (no state change): `_prepareSwap` (ownerOf check, positions read +
  marketId cross-check, Pa/Pb via TickMath, oracle-pinned P0, in-range gate, computeMaxIL,
  entry snapshot, V0 — `:580-608`); fair-value read; premium computation.
- **PHASE 2 — CHECKS**: dust gates, ratio band, validity window, nonce, **I9 band check**,
  **I7 capacity**, MM solvency, **I10 load ceiling**, slippage (`maxPremium`).
- **PHASE 3 — EFFECTS** (state, no external calls): atomic `consumedNotional +=`,
  `_useNonce`, `lockCollateral`, write `SwapRecord` (`_executePathA:727-746` /
  `_executePathB:775-797`).
- **PHASE 4 — INTERACTIONS** (external last): pull premium, take NFT custody, distribute
  premium (`:748-758` / `:799-809`).

**`settle` is strict CEI with status-flip-first** (`InflexionCore.sol:1074-1115`): `s.status
= Status.SETTLED` is hoisted to *immediately after* the validity checks, *before* any
external call (`:1079`), so a malicious `oracle`/`ilMath` re-entering `settle` on the same
`swapId` hits the `Status.ACTIVE` precondition and reverts. This was the **one Slither
medium fixed** (`reentrancy-no-eth`, PR/commit 5.13 — `docs/SECURITY.md:266-276`).

---

## 5. The two architectural forks (from the external audit)

### Fork 1 — Oracle settlement-liveness deadlock → Option B (round-at-T pinning + lone-spike + backstop)

- **The problem (GPT/Gemini audit):** v3.1's round-at-T + pinned-Uniswap-TWAP could
  deadlock *permanently* — Chainlink and TWAP at T are both frozen, so a >2% divergence at
  T would revert forever (`inflexion-audit-findings` memory, v3.2 note).
- **The fix:** price still pinned to the Chainlink round-at-T (fairness); the hard TWAP
  gate is **replaced** by a Chainlink **lone-spike sanity check** (round-at-T is "lone"
  only if it differs from **both** neighbours by ≥ `LONE_SPIKE_BPS = 500` / 5% — real fast
  moves persist across rounds and pass) **plus** a `LIVENESS_WINDOW = 86,400s` (24h)
  backstop that unconditionally accepts the round after the window. TWAP demoted to a
  non-blocking advisory event. → **invariant I8**, implemented in
  `OracleManager.getSettlementPrice` (`:237-315`).
- **Resolution window:** funds settle within `[expiry + LIVENESS_WINDOW, expiry + MAX_STALENESS)`
  ≈ 1h with current constants — see the I8 design observation in §1.

### Fork 2 — No-last-look firm-quote pickoff → Option B (oracle-anchored price band)

- **The problem (GPT High audit):** firm quotes + any clock-based validity feed a one-sided
  stale-quote pickoff. **Signed payloads are bearer instruments** that survive in any hand
  that copied them, beyond the off-chain engine's cancel; when vol gaps, the MM is short
  convexity and a searcher can submit the leaked bytes on-chain (`spec.md:365`,
  `inflexion-audit-findings` v3.3 note).
- **The fix:** each `SignedQuote` carries `quotePrice` (oracle price the MM saw at signing)
  + `priceBandBps`. At `createSwap` the contract reads the live oracle (the *same* read
  that pins `P0`) and **auto-voids the quote on-chain, deterministically, if
  `absBps(P_live, quotePrice) > priceBandBps`** — no MM discretion at fill ⇒ **not
  last-look** (no fading, no abuse). → **invariant I9**, `InflexionCore.sol:887-895`.
- **`validUntil` tightened** from [5s, 60s] to default **8s**, band **[5s, 15s]**
  (`InflexionCore.sol:89-90` `VALIDITY_MIN_S=5`/`VALIDITY_MAX_S=15`; bounds checked at
  `:875-881`). The band is the *primary* defense; the clock is a secondary
  leakage-window control.
- **Why firm + band beats last-look:** "last look" undercuts trustlessness and enables the
  exact abuse pattern auditors flag (MM fades at settlement). The hybrid keeps firm quotes
  + the oracle band and adds **no last-look path** (a CLAUDE.md hard rule). MM protection is
  three deterministic on-chain mechanisms: the oracle band (kills the dominant pickoff),
  the short `validUntil`, and on-chain selective nonce invalidation.
- **Acknowledged residuals** (not blockers): vol-only moves (IV jumps with little spot
  drift) aren't caught by a *spot* band — small surface on crypto majors, mitigated by
  `validUntil`; within-band drift the MM bears (it chose the band); oracle lag if Chainlink
  hasn't ticked (majors tick on 0.05% deviation) (`spec.md:387-391`).

---

## 6. The full audit history (12 spec fixes + 2 forks; quant audit; Slither x2)

### 6.1 Spec audit (pre-build) — multi-LLM (Claude Opus, GPT-5, Gemini 2.5) → spec v3.3

Consensus: FULL/European core sound, no-bad-debt invariant genuine, PARTIAL correctly
deferred. The meta-risk all three converged on: **two-sided market clearing** (LP WTP vs
MM widening) — a strategic concern resolvable only empirically post-deploy.

**12 fixes applied** (`inflexion-audit-findings` memory; `docs/SECURITY.md:54-56`):
1. Store `L` at creation, use at settlement (kills `increaseLiquidity` inflation → I6).
2. Reject out-of-range entries (`Pa ≤ P0 ≤ Pb`).
3. Ring-fence collateral rehypothecation (idle-only, never utilization-gated like Aave).
4. On-chain authoritative quote capacity + replay + Permit2 bitmap-nonce selective cancel (→ I7).
5. Dust/precision floors (`MIN_POSITION_V0`/`MIN_PREMIUM`, round-up premium).
6. Reposition as **in-range convexity hedge**, not "IL insurance" (payoff diagrams; qualified bad-debt claim).
7. Surface 1 → "convexity-premium index", not implied vol.
8. Intra-band adverse-selection caveat (later *retired* in v4.0 — geometry is public, §3.4).
9. Direct-to-contract bypass + published quote log.
10. Secondary-exit roadmap (novation / MM-side ERC721 / LP early-terminate).
11. Gross-IL-not-net-P&L clarification.
12. Convexity proof written out. *Non-issue confirmed:* MaxIL boundary-max is correct.

Then **Fork 1 → v3.2** and **Fork 2 → v3.3** (above). The original audit files were
cleared after integration into spec; the summary lives in project memory only.

### 6.2 Quant audit (Phase 14.11) — adversarial review of the Monte Carlo solvency model

GPT-5 + Code Interpreter + Gemini 2.5 Pro. 6 HIGH findings; **9 fixed in-band, 6 deferred
as named mainnet-TODOs** (`docs/SECURITY.md:226-254`). Key fixes: `n_runs` 1,000 → 50,000
(1k meaningless for a 0.1%-tail estimate); VaR → **CVaR** for `fund_target` (coherent,
tail-aware); mean-PnL (not median) fee criterion; fixed-point bisection for
`c_min ↔ fund_target`; severe-stress params re-anchored to Terra/FTX/Mar-2020/May-2021;
`parameter_provenance` per field; annualised ruin budget surfaced
(`0.1%/30d ≈ 1.21%/year`); 8 hand-calculated `il.py` fixtures from Uniswap §6.30.
**No PARTIAL constant is ever hardcoded** — every PARTIAL/cvAMM primitive is read from the
quant (`params.json` / `params.cvamm.schema.json`); hardcoding any is the exact failure the
audit flagged (CLAUDE.md hard rule).

### 6.3 Solidity static analysis (Slither 0.11.5) — two passes

- **Core pass:** 27 findings → **1 fixed** (`reentrancy-no-eth` in `settle`, §4 above) **+
  26 accepted false-positives** (`unused-return` on idiomatic tuple destructuring,
  `reentrancy-benign`/`-events` on post-call SwapRecord writes + events,
  `timestamp` on protocol time checks, etc. — `docs/SECURITY.md:256-292`).
- **cvAMM pass (P3.9):** 74 results → **0 high, 0 confirmed vulnerabilities, 1 cleanup**
  (stray foundry-template `Counter.sol` deleted — the only `^0.8.13` usage). Manual review
  confirmed the junior-first-loss waterfall, the withdrawal cooldown + locked/free run
  defense, and the `lockedAfter ≤ juniorAssets` senior-protection check; and that **the FULL
  no-bad-debt guarantee (I1) is structural and independent of the FairValue/Vol oracles** —
  `settle` caps payout at `MaxIL == collateral` (`docs/SECURITY.md:294-325`).
- **Reproduce:** `slither packages/contracts --filter-paths "test|script|lib"`.
- **CI scope note:** GitHub Actions runs only `forge fmt + build + test`; `cargo
  stylus`/Node/Python validation is manual (WSL2/Nitro). The Solidity `FairValueOracle` *is*
  exercised in CI (it's what `forge test` compiles) — its role as the revm-executable
  cross-check of the shipped Stylus oracle (`docs/SECURITY.md:23-28`).

---

## 7. Attack-vector ↔ mitigation table

| Attack vector | Mitigation | Code / invariant |
| --- | --- | --- |
| MM bad debt under price move | FULL collateral = MaxIL + `payout = min(IL, MaxIL)` cap. Structural. | I1 + I2 — `InflexionCore.sol:1099` |
| Lone-spike Chainlink glitch at expiry | Round-at-T pin + lone-spike vs **both** neighbours (≥5%) + 24h liveness backstop | I8 — `OracleManager.sol:286-307` |
| Permanent fund lockup if oracle deferral never resolves | Backstop accepts the round past `LIVENESS_WINDOW`; tolerant `_tryRound` across phaseId boundary | I8 — `OracleManager.sol:266,301-307,322-331` |
| Stale-quote pickoff (bearer-instrument leakage, Fork 2) | Oracle-anchored band, auto-voids on-chain, deterministic — not last-look | I9 — `InflexionCore.sol:887-895` |
| LP lies about position range geometry | `sqrtPa/Pb` from `positions().tickLower/Upper` via TickMath; `(token0,token1,fee)` cross-check | `InflexionCore.sol:588-594` |
| Settler chooses the settlement price | `P_T` derived on-chain from Chainlink round-at-T, never calldata | I2/I4 — `InflexionCore.sol:1089` |
| LP picks a favorable entry price (sets MaxIL/premium/V0) | `P0` derived on-chain from Chainlink, clamped to MM band | `InflexionCore.sol:597-598` |
| External `increaseLiquidity` on custodied NFT (F-#2) | `L` snapshotted at creation, settle uses stored value | I6 — `InflexionCore.sol:744,1095` |
| Bearer-quote replay after off-chain cancel (F-#7) | Permit2-style bitmap nonces + selective `cancelNonces([])` | I7 — `InflexionCore.sol:445-478` |
| Capacity over-consumption from concurrent fills (F-#6) | Atomic check-and-increment in PHASE 3, before any external call | I7 — `InflexionCore.sol:776,897` |
| Dust-swap MM griefing (F-#8/13) | `MIN_POSITION_V0 = $100`, `MIN_PREMIUM = $1` | `InflexionCore.sol:78,82,867-868` |
| Premium under-charge from integer division (F-#8) | `premium = ceilDiv(...)` — rounds **up** | `CvammPricing.sol:117`, `InflexionCore.sol:618,656` |
| Overcharge the LP | Load clamped ≤ maxLoad (Path A) / `loadBps ≤ maxLoadBps` (Path B), by construction | I10 — `CvammPricing.sol:80-89`, `InflexionCore.sol:855-857` |
| Sequencer downtime exploitation | `_requireSequencerHealthy` enforces uptime + 1h grace, fails-closed on future `updatedAt` | `OracleManager.sol:118-130` |
| NFT custody hijack | `ILVault.onERC721Received` accepts NFTs only from the canonical NPM; `claimFees` recipient forced to registered LP | `ILVault` (`docs/SECURITY.md:71`) |
| Locked-collateral utilization-gated withdraw failure (F-#3) | Yield adapter must be `isInstantlyRedeemable()`; never Aave/Compound for locked; only idle slice to sDAI/T-bills | `IYieldAdapter` (`docs/SECURITY.md:72`) |
| Pool run on the cvAMM | Cooldown-gated withdrawals; junior can't be drawn below `totalLocked` | `ConvexityVault.sol:222-265` |
| Underwriting loss hits senior depositors | `totalLocked ≤ juniorAssets` at every lock; junior-first waterfall | `ConvexityVault.sol:291-293,321-328` |
| Forged MM quote | Every Path-B quote EIP-712 signed; verified via `SignatureChecker` (ECDSA + EIP-1271) | `QuoteVerification.sol:73-80` |
| Re-entrant `settle` via malicious oracle/ilMath | Status flips to SETTLED first, strict CEI | `InflexionCore.sol:1079` |

---

## 8. Trust model — trustless vs trusted, and what the matcher cannot do

Settlement is **non-custodial and on-chain.** The off-chain matching engine exists for
**Path B only** (Path A is pure on-chain pool pricing — no relayer, no keeper, no validity
clock). The engine's power is strictly bounded (`spec.md:408-418`, `docs/SECURITY.md:329-352`):

| The engine CAN | The engine CANNOT |
| --- | --- |
| Censor / reorder Path-B quotes (liveness / fairness) | **Steal funds** — settlement is against the counterparty's own collateral (pool on A, MM's `UnderwriterVault` on B) |
| Pick which signed quotes to surface | **Forge quotes** — every Path-B quote is MM-signed (EIP-712 / EIP-1271) |
| Drop quotes from its book | **Force a stale quote** — `validUntil` + on-chain nonce + the oracle band (I9) |
| | **Bypass the band check** — the I9 band is enforced on-chain |
| | **Censor Path A at all** — Path A needs no engine; the LP transacts directly on-chain against the pool |

**Mitigations against the powers it *does* have** (F-#13):
1. **Direct-to-contract fallback** — because EIP-712 verification is on-chain, any LP
   holding a valid signed quote can call `createSwap` *directly*, bypassing the engine. The
   SDK exposes this path, so a censoring operator simply loses that flow.
2. **Append-only quote log** — the engine publishes its full quote stream + match decisions
   to a rotating append-only log, making ordering auditable.
3. **Deterministic price-time / FIFO matching rules.**

The operator can degrade Path-B liveness/fairness but cannot capture users who route around
it — and Path A is immune. **Decentralization roadmap:** an Arbitrum **Orbit chain** could
host the Path-B quote book fully on-chain (Hyperliquid pattern), removing the off-chain
component entirely — out of hackathon scope, but the clean answer to "isn't the matcher
centralized?" And **the cvAMM is already fully on-chain today** (`spec.md:418`).

**The FULL no-bad-debt guarantee is independent of matching** — it is enforced at on-chain
settlement (collateral = MaxIL, payoff capped), regardless of how the quote was discovered
or which path opened the swap (`spec.md:314`).

**Signature verification** broadened from `ECDSA.recover` to OZ
`SignatureChecker.isValidSignatureNow` to support **EIP-1271 contract signers** (incl. a
vault-signer), while EOA-signed quotes still validate identically — non-breaking
(`QuoteVerification.sol:73-80`, `InflexionCore.sol:841-847`). This and the
`premiumRate → loadBps` field swap were the only EIP-712 schema changes, flagged explicitly
per CLAUDE.md's "do not silently change EIP-712 verification" rule (`spec.md:318`,
`spec.md:340`).

---

## 9. Routing safety — `createSwapRouted` never reverts on a bad MM quote

`createSwapRouted` routes the LP to the **cheaper of {pool, valid MM quote}**, both derived
from the **same on-chain FairPremium** (single VolOracle poke), so the MM wins **only when
it strictly beats** the capped pool price; a **tie resolves to Path A**
(`InflexionCore.sol:998` `useB = usableB && premiumB < premiumA`). An **absent / expired /
stale / under-collateralised / over-band / over-load / zero-price** MM quote does **not
revert** — the `view` predicate `_quoteUsableAndPremiumB` returns `(false, 0)` and the swap
falls back to the always-on pool (`:682-715`). Only protocol-level failures (market / owner
/ range / dust / slippage / pool-unwired) revert. **Only the executed rail mutates
nonce/capacity/lock**, so an unchosen quote leaves zero trace (I7 preserved — `:971`).

---

## 10. Immutability, custody, and the EIP-170 size note

- **No upgradability** — all deployed contracts are immutable. Wiring uses a one-shot
  `setCore` + `freezeCore` (and `setCvamm` + `freezeCvamm`) pattern: wire the vaults to
  `InflexionCore` once, then permanently lock it (`UnderwriterVault.sol:87-102`,
  `ConvexityVault.sol:129-142`, `InflexionCore.sol:396-420`). There is no admin path to
  redirect a vault's `core` after freeze.
- **NFT custody** — the LP's position NFT is held by `ILVault` during the swap;
  `onERC721Received` accepts NFTs only from the canonical NonfungiblePositionManager
  configured at deploy; `claimFees` recipient is forced to the registered LP; `returnNFT`
  hands it back at settle (`InflexionCore.sol:1112`).
- **EIP-170 size-pass (resolved, but worth knowing for Q&A).** Adding the moat events
  (`SwapPriced` / `QuoteFilled`) pushed `InflexionCore` **+213 B over the 24,576 B EIP-170
  limit (24,789 B)**; `forge build`/`test` (revm) are unaffected but a *deploy* would fail
  (`spec.md:995`). **This was resolved in the 2026-06-05 redeploy** by lowering
  `optimizer_runs` to 1500 (and extracting public libraries `CvammPricing`,
  `QuoteVerification`, `SwapMath`, `TickMath` as delegatecall code) — the deployed
  `InflexionCore` is **23,934 B, under the limit**
  (`deployments/arbitrum-sepolia.json:41`). *(Note: `spec.md:995` still describes the
  pre-redeploy blocker; the registry reflects the resolved deploy. Flagged as a stale spec
  line, not a live blocker.)*

---

## 11. Live deployment (Arbitrum Sepolia, chainId 421614, redeploy 2026-06-05)

Registry: `deployments/arbitrum-sepolia.json`. Numéraire dUSDC = 6 decimals.

| Contract | Address | Role / security relevance |
| --- | --- | --- |
| `InflexionCore` | `0xC19865cF8403F59B8Eca835833aFEe3Aa8DA4848` | State machine; enforces I1–I10; CEI settlement |
| `OracleManager` | `0x2c18147B6ec75dcb330d9A48B6B96a4d1a8b529b` | Chainlink + sequencer + Fork-1 round-walking (I8) |
| `VolOracle` | `0xfdEafBB381192FC5337499d041eaead04d565Ed9` | `σ_ref` EWMA — load-bearing for I10/solvency, **not** I1 |
| `ILMath` | `0x7e90362bc6Df9cb5faA13952e07853ab16c77bd2` | **Production** settle-path IL math (I3/I4) |
| FairValueOracle (Stylus) | `0x98a6aa75108b70fc0794bc3b87efe0ae99d5d52c` | **Production** Φ-sum pricer, 6.7e-15 precision, upstream of settle |
| `ConvexityVault` | `0xDE2fFeBA2E6A18f3A53D43EC0fCCD299158eC30d` | Dual-tranche cvAMM; `totalLocked ≤ juniorAssets`; run defense (Path A) |
| `UnderwriterVault` | `0x4Fb459F3393D206c2b7faD7f0fC9C35a78348D64` | Per-MM collateral; I5 (Path B) |
| `ILVault` | `0x9f7615Aca943832977CEf3ac1862fD48B87b7664` | ERC-721 custody |

- **No sequencer feed on Sepolia** (testnet, no SLA) — `sequencerFeed == address(0)` skips
  the sequencer gate; **must be set before any mainnet deploy** (registry `_sequencerNote`,
  `OracleManager.sol:15-17`).
- **Stylus ILMath is a rejected benchmark** (P3 closed; ~5.3× *more* expensive cached for
  this tiny kernel) — **on-chain IL is Solidity `ILMath`**; the v3.3 "~10× cheaper" claim
  was inverted (`spec.md:948-956`). Only the *compute-heavy* FairValueOracle benefits from
  Stylus.
- **The Φ-sum is NEVER reimplemented off-chain** (CLAUDE.md hard rule). Stylus
  FairValueOracle = production; Solidity `src/FairValueOracle.sol` = revm-testable CI
  cross-check only (`spec.md:106`, `spec.md:959-963`).
- **Live create→settle lifecycle ran on the fresh stack** (`lifecycle` block): Path A
  (cvAMM) swap #1 — premium $9.70 on MaxIL $1,669.24 (0.58% of MaxIL), settled $148.64 from
  the ConvexityVault; Path B routed swap #2 — `createSwapRouted` picked the MM ($8.93 vs
  cvAMM $13.80), locked + paid $245.66 from the **MM's own** `UnderwriterVault` collateral
  (`deployments/arbitrum-sepolia.json:77-106`). This demonstrates the trust model end to
  end: the counterparty's own collateral pays, not protocol funds.
- **Subgraph deploy pending** — the on-chain moat dataset begins at this redeploy block
  (`_deployBlock = 274081134` is the subgraph `startBlock`); until the subgraph lands,
  history degrades to a typed pending state (registry `_note`).

---

## 12. One-paragraph judge-Q&A summary

Inflexion's security rests on one structural fact: in FULL mode collateral is locked at
`MaxIL` and coverage is `min(realized_IL, MaxIL)`, so `payout ≤ collateral` by
construction (I1/I2) — a proof that is *oracle-independent* and holds under any price path,
qualified only by capped payoff + solvent USDC + oracle/settlement liveness + no
rehypothecation breach. Around that core, ten Foundry-fuzzed invariants (I1–I10) and a
multi-LLM spec audit (12 fixes + two resolved forks: the Chainlink round-walking liveness
backstop for I8, and the deterministic oracle-anchored price band — *not* last-look — for
I9) close every audited vector. The off-chain matcher (Path B only) is strictly bounded: it
cannot steal, forge, or force-stale, and Path A is fully on-chain and immune to it; the
cvAMM adds a code-capped fair price (I10, by construction) plus structural junior-first-loss
senior protection (`totalLocked ≤ juniorAssets`) — while honestly disclosing that depositor
capital is *not* guaranteed for either tranche.
