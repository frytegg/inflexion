# Inflexion — Security

Invariants the protocol enforces, attack vectors it defends against,
and what's been verified vs what's deferred. Companion to
[`MATH.md`](./MATH.md) (the formulas) and `spec.md` §13 (the canonical
list).

---

## 0. Status snapshot

|                                    | Status                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| FULL / EUROPEAN core flow          | ✅ implemented + tested (Phases 3–5)                                                        |
| Solidity invariant suite           | ✅ 10 invariants, 6 covered with fuzz, 1 documented as design observation                   |
| Quant audit                        | ✅ external multi-LLM audit (GPT-5 + Gemini 2.5), 9 fixes in-band, 6 mainnet-TODOs explicit |
| Solidity static analysis (Slither) | ✅ Slither 0.11.5, 27 findings triaged (1 fixed, 26 accepted) — see §4.3                    |
| Mainnet-fork integration           | ⏸️ Task 5.11 (pending)                                                                      |
| Sepolia deploy                     | ⏸️ Task 5.14 (pending)                                                                      |
| PARTIAL mode                       | ⏸️ Phase 15 (stretch — gated on quant; not in v1)                                           |
| Stylus ILMath cross-check          | ⏸️ Task 2.11 (pending — home-PC track)                                                      |

> **CI scope:** GitHub Actions (`.github/workflows/ci.yml`) runs only `forge fmt` +
> `forge build` + `forge test`. It does **not** run `cargo` / `cargo stylus`, the
> Node benchmark scripts, or the Python suite — so all **Stylus** and **quant**
> validation is manual (local Nitro / WSL2). The Solidity `FairValueOracle` _is_
> exercised in CI (it is what `forge test` compiles), which is why it is retained
> as the revm-executable cross-check of the shipped Stylus oracle.

---

## 1. Invariants

All ten invariants from spec §13 with their verification status. Test
references point to files in `packages/contracts/test/`.

| #       | Invariant                                                                                                              | Where enforced                                                                                                                                                                                                                                            | Verified by                                                                                                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I1**  | `payout ≤ collateral == MaxIL` (FULL: no bad debt)                                                                     | `InflexionCore.settle` payout cap                                                                                                                                                                                                                         | `InflexionCore.invariants.t.sol::testFuzz_I1_I2_payoutCappedAtMaxIL` (256 runs)                                                                                                                          |
| **I2**  | `payout == min(realised_IL, MaxIL)`                                                                                    | same                                                                                                                                                                                                                                                      | same                                                                                                                                                                                                     |
| **I3**  | No underflow when `V_lp > V_hold`                                                                                      | `ILMath._ilAt` (guarded `max(0, …)`)                                                                                                                                                                                                                      | `ILMath.t.sol::testFuzz_I3_ilNonNegative` (256 runs)                                                                                                                                                     |
| **I4**  | LP never profits from the swap                                                                                         | same clamp                                                                                                                                                                                                                                                | `ILMath.t.sol::test_il_atEntryIsZero` + I3 fuzz                                                                                                                                                          |
| **I5**  | `locked[mm] ≤ deposited[mm]` per MM                                                                                    | `UnderwriterVault.{lockCollateral, releaseAndDistribute}` arithmetic                                                                                                                                                                                      | `InflexionCore.invariants.t.sol::invariant_I5_lockedLeDeposited` (**256 runs × 128,000 fuzzed vault op calls × 0 reverts**)                                                                              |
| **I6**  | Settlement uses `L` stored at creation, never re-read                                                                  | `SwapRecord.liquidity` stored once; `settle` passes `s.liquidity` to `IILMath.computeIL`                                                                                                                                                                  | `InflexionCore.invariants.t.sol::testFuzz_I6_recordsStoredLiquidity` (256 runs, MockILMath recorder pins the actual `liquidity` arg) + `ILVault.t.sol::testFuzz_F2_externalIncreaseLiquidity` (256 runs) |
| **I7**  | `consumedNotional[quoteId] ≤ maxNotionalV0`; cancelled-nonce bit cannot fill                                           | `createSwap` PHASE 3 effects: atomic check-and-increment before any external call                                                                                                                                                                         | `InflexionCore.t.sol::test_createSwap_consumedNotional_tracked` + `test_createSwap_rejectsUsedNonce`. Full handler-driven stateful fuzz deferred to post-mainnet.                                        |
| **I8**  | `settle()` always succeeds within `expiry + LIVENESS_WINDOW + MAX_STALENESS + GRACE_PERIOD` (no permanent fund lockup) | `OracleManager.getSettlementPrice` Fork-1 (Option B)                                                                                                                                                                                                      | `OracleManager.invariant.t.sol` — 5 fuzz tests, **1,280 runs** across the feasible window. **See §3 below** for a documented Fork-1 design observation.                                                  |
| **I9**  | Quote auto-voids on-chain iff `absBps(P_live, quote.quotePrice) > priceBandBps` (Fork 2)                               | `createSwap` PHASE 2 band check                                                                                                                                                                                                                           | `InflexionCore.invariants.t.sol::testFuzz_I9_priceBandViolationReverts` + `WithinBandAccepts` (256 runs each, both directions)                                                                           |
| **I10** | `premium ≤ FairPremium · (1 + maxLoadBps)` (price cap; LAUNCH; **by construction**, upstream of `settle`)              | Mechanical, deterministic clamp `baseLoad + util_skew + dispersion_skew ≤ maxLoad` on Path A + `require(loadBps ≤ maxLoadBps)` on Path B, in PHASE 1 (pricing, READ). Orthogonal to the no-bad-debt proof — does **not** touch `settle`, MaxIL, or I1–I9. | `InflexionCore.invariants.t.sol` — fuzz `FairPremium` / skews / `loadBps` across their ranges and assert `charged ≤ fairPremium · (1e4 + maxLoadBps) / 1e4` (spec §13 I10)                               |

---

## 2. Attack vectors considered + mitigations

Sourced from spec §9 + the external audit findings memory
(`inflexion-audit-findings`, 12 fixes applied → spec v3.3, 2 forks
resolved). The audit work is summarised in PR #5 + Phase 14.11.

| Vector                                                             | Mitigation                                                                                                                                                                      | Reference                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **MM bad debt under price move**                                   | FULL collateral = `MaxIL` + `payout = min(IL, MaxIL)` cap. Structural, not heuristic.                                                                                           | I1 + I2                                        |
| **Lone-spike Chainlink glitch at expiry**                          | Round-at-T pinning + lone-spike sanity check vs both neighbours (≥5% from both = lone) + liveness backstop at 24h                                                               | spec §6.1 / `OracleManager.getSettlementPrice` |
| **Permanent fund lockup if oracle deferral never resolves**        | Liveness backstop accepts the round at expiry past `LIVENESS_WINDOW`                                                                                                            | I8 — but see §3 below                          |
| **Stale-quote pickoff (Fork 2 — original GPT High audit finding)** | Oracle-anchored price band: `absBps(P_live, quote.quotePrice) ≤ priceBandBps`. Auto-voids on-chain, deterministic — not last-look.                                              | I9 / spec §4.3.3                               |
| **LP lies about position range geometry**                          | `sqrtPa` / `sqrtPb` derived on-chain from `positions(tokenId).tickLower / tickUpper` via TickMath. LP cannot under-state range to shrink MaxIL.                                 | `InflexionCore.createSwap` / PR #9             |
| **External `increaseLiquidity` on custodied NFT (F-#2)**           | `L` snapshotted at creation, stored in `SwapRecord.liquidity`, settlement uses STORED value                                                                                     | I6                                             |
| **Bearer-quote replay after off-chain cancel (F-#7)**              | Permit2-style bitmap nonces + per-MM `cancelNonces([])` to flip bits selectively                                                                                                | spec §4.3.2 / `InflexionCore.cancelNonces`     |
| **Capacity over-consumption from concurrent fills (F-#6)**         | `consumedNotional[quoteId]` atomic check-and-increment in PHASE 3 effects, before any external call                                                                             | I7                                             |
| **Dust-swap MM griefing (F-#8/13)**                                | `MIN_POSITION_V0 = $100` and `MIN_PREMIUM = $1` gates                                                                                                                           | `InflexionCore.createSwap` PHASE 2             |
| **Premium floor under-charge from integer division (F-#8)**        | `premium = ceilDiv(rate · MaxIL, 10_000)` — rounds UP                                                                                                                           | spec §5.2 / `Math.ceilDiv`                     |
| **Sequencer downtime exploitation**                                | `OracleManager._requireSequencerHealthy` enforces uptime + 1h grace, fails-closed on future-dated `updatedAt`                                                                   | spec §6.2                                      |
| **NFT custody hijack**                                             | `ILVault.onERC721Received` accepts NFTs ONLY from the canonical NonfungiblePositionManager configured at deploy; `claimFees` recipient FORCED to registered LP                  | `ILVault`                                      |
| **Locked-collateral utilization-gated withdraw failure (F-#3)**    | Yield adapter interface enforces `isInstantlyRedeemable()`; never route locked collateral into Aave/Compound; only liquid wrappers (sDAI, tokenized T-bills) for the idle slice | `IYieldAdapter`                                |

---

## 3. Documented design observations

These are NOT bugs — they're behaviours of the current implementation
that differ from the most ambitious reading of the spec and that we've
chosen to surface in NatSpec rather than paper over. Tracked for spec
review.

### 3.1 Fork-1 feasible settlement window (~1 hour, not unlimited)

**Spec wording (§13 I8):** "`settle()` always succeeds within
`expiry + LIVENESS_WINDOW + MAX_STALENESS + GRACE_PERIOD`."

**Implementation reality:** the staleness `require` in spec §6.1's
literal code fires _before_ the backstop can recover the round. The
actual usable settlement window is:

```
[ expiry + LIVENESS_WINDOW,  expiry + MAX_STALENESS )
≈ 1 hour wide  (86,400s → 90,000s with current constants)
```

Past `expiry + MAX_STALENESS` the pinned round is "stale" per the
spec-literal check; funds can still be settled via a _newer_ Chainlink
round (Arbitrum majors tick frequently), but not via the round-at-T.
The 1h window is symmetric for both LP and MM (preserves fairness),
just tighter than the I8 wording suggests.

**Documented in:** `OracleManager.getSettlementPrice` NatSpec + the
boundary-pin test
`OracleManager.invariant.t.sol::test_I8_revertsPastStaleness_boundary`.

**Possible remediations** (for spec review, not Phase 1):

- Bypass the staleness check when the backstop fires (one-line change,
  spec change required)
- Widen `MAX_STALENESS` to give the backstop more breathing room
- Accept the 1h window as the protocol guarantee and update spec wording

### 3.2 `MarketConfig` registry (not in spec)

Spec §4.4 defines `marketId = keccak(token0, token1, fee, durationSeconds)`
but doesn't specify how the contract resolves those four values from a
`marketId`. We added an owner-managed `MarketConfig` registry; governance
pre-registers each market with `(token0, token1, fee, durationSeconds,
oracleToken)`. `createSwap` cross-checks the position's actual
`(token0, token1, fee)` against the registered tuple.

**Documented in:** `InflexionCore` NatSpec. Worth promoting into spec
as a first-class concept.

### 3.3 Reference magnitudes in spec §3.2 are ~4× too low

Spec table:

```
±5%  range → MaxIL ≈ 0.3% of V0
±10% range → MaxIL ≈ 1.2% of V0
±20% range → MaxIL ≈ 4.8% of V0
±50% range → MaxIL ≈ 25%  of V0
```

Empirically measured (`quant/notebooks/03_path_to_il.ipynb`):

```
±5%  range → MaxIL ≈ 1.2% of V0
±10% range → MaxIL ≈ 2.4% of V0
±20% range → MaxIL ≈ 4.7% of V0
±50% range → MaxIL ≈ 13.8% of V0
```

Spec placeholders should be updated. Tracked in
[`docs/MATH.md`](./MATH.md) §3.

### 3.4 Oracle-pinned pricing — entry `P0` and settlement `P_T` (vNEXT fix)

A review found that `createSwap` and `settle` accepted a **caller-supplied** sqrt
price. `settle` computed the payout from the caller's `sqrtP_T` (the validated
Chainlink price was only emitted), so any permissionless settler could set the
payout anywhere in `[0, MaxIL]`; `createSwap` took the entry `sqrtP0` bounded only
to `[Pa, Pb]`, letting an LP pick the entry that sets MaxIL / premium / V0. Both
prices are now **derived on-chain** from Chainlink via `_oracleSqrtPriceX96`
(decimal- and orientation-aware; `MarketConfig` decimals are read on-chain at
`registerMarket`, never trusted from calldata; the oracle orientation is immutable
across re-registration). This restores invariants **I2 / I4** and the Fork-1
oracle pinning, and aligns the code to spec §5.2/§5.4 (which already specified
`P0 = oracle.getPrice`). Accepted residuals, by design:

- **In-range is now defined at the ORACLE price, not the pool's `slot0`.** The
  `Pa ≤ P0 ≤ Pb` gate compares the Chainlink-derived `P0`. When oracle and pool
  spot diverge (normal basis, thin pool, transient dislocation), a position that
  is in-range by pool-truth but out-of-range by the oracle is rejected (and vice
  versa). Intentional and consistent with settlement (also oracle-pinned); not a
  fund-loss vector.
- **Bounded entry-timing freedom.** `P0` is the latest Chainlink round at the
  LP's chosen block, clamped to within `priceBandBps` of the MM-signed
  `quotePrice` over a 5–15 s validity window, so an LP can prefer a marginally
  favourable round — bounded by the MM's chosen band, blunted by premium scaling
  with MaxIL. This is the intended firm-quote + oracle-band design (I9), not a drain.
- **Phase-boundary liveness.** `getSettlementPrice` reads neighbour rounds
  tolerantly (`_tryRound`): across a Chainlink `phaseId` boundary (where
  `roundId ± 1` is not the real neighbour) a missing next round degrades to the
  liveness backstop (accept the pinned round past `LIVENESS_WINDOW`) rather than a
  permanent fund-lock (invariant **I8**). It never lets a settler choose the price
  — the round-at-T is uniquely bracketed below by `updatedAt ≤ expiry`.

Roadmap hardening (not blocking): decimals are validated on-chain today; for any
future **non-USD-quoted** pair the USD-stable = \$1 numéraire assumption (spec §19)
must be revisited before listing.

### 3.5 `r = 0` / zero-drift forward assumption (fairRate)

`fairRate = E_Q[min(IL, MaxIL)] / MaxIL` is priced under risk-neutral GBM with the
forward pinned at `F = P0` (martingale, `r = 0`, `q = 0`). A nonzero financing rate
`r` or ETH staking yield `q` tilts the true risk-neutral forward to
`F = P0·exp((r − q)·T)`, and the v3 IL payoff is asymmetric about `P0`, so the tilt
is not strictly price-neutral. **Sized and found economically negligible at launch
scope** (re-pricing `il.py` under a forward-tilted terminal across widths ±5–50% and
7/30/90-day durations, σ = 0.6):

- Worst **absolute** move: **+0.32 pts of MaxIL** (±20%, 90d, aggressive
  `θ = r − q = −0.08`); worst **relative** move: **+0.7%**.
- Worked $50k / ±10% / 30d position (MaxIL $1,280): premium moves ≤ **$1.30** even at
  `θ = −0.08`; ≤ **$2.50** at 90d — at/below the $1 dust-floor resolution for typical
  carry (`|θ| ≤ 0.04`) and well inside the load.

Conclusion: `r = 0` is acceptable for the buildathon; revisit only for long-dated
(≥ 90d) or high-carry pairs. _(Original red-team sizing; the scratch script that
produced these figures has been removed — this paragraph is the retained record.)_

---

## 4. External audit summary

### 4.1 Spec audit (pre-build, Phase 0)

Multi-LLM external audit (Claude Opus 4.7, GPT, Gemini) of the protocol
design. Result: 12 fixes applied → spec v3.3 + 2 architectural forks
resolved:

- **Fork 1** (Option B) — oracle settlement deadlock: round-at-T pinning
  - lone-spike sanity + liveness backstop. Implemented in `OracleManager`
    (Phase 3).
- **Fork 2** (Option B) — firm-quote pickoff: oracle-anchored price band.
  Implemented as the `absBps(P_live, quotePrice) ≤ priceBandBps` check in
  `InflexionCore.createSwap` (Phase 5). Invariant I9.

Audit details live in project memory (`inflexion-audit-findings`); the
original audit files were cleared after integration into spec v3.3 per
project policy.

### 4.2 Quant audit (Phase 14.11)

Independent adversarial audit of the Monte Carlo solvency model
(GPT-5 + Code Interpreter, Gemini 2.5 Pro). 6 HIGH-severity findings;
9 fixed in-band, 6 deferred as mainnet-TODOs with named owners.

**Key fixes (per PR #5):**

- `n_runs` 1,000 → 50,000 (1k was statistically meaningless for a
  0.1%-tail estimate)
- VaR → CVaR for `fund_target` (coherent, tail-aware)
- Mean-pnl criterion for fee curve (not median)
- Fixed-point bisection for `c_min ↔ fund_target` (replaces hand-picked
  bootstrap)
- Severe stress params re-anchored to historical episodes (Terra, FTX,
  March 2020, May 2021)
- `parameter_provenance` per field (calibrated / heuristic / deferred)
- Annualised ruin budget surfaced (`0.1%/30d ≈ 1.21%/year`)
- 8 hand-calculated `il.py` fixtures from Uniswap §6.30 (audit C1)

**Deferred to mainnet** (documented in `quant/params.json.notes`):

- Portfolio-level multi-market calibration
- Empirical position mix from Uniswap subgraph
- Joint c_min × fee_curve optimisation
- Multi-period fund evolution
- MM / LP behavioural models
- Multi-σ floor curve
- Depeg / oracle-failure / liquidation cascade mechanisms

### 4.3 Solidity static analysis (Slither)

Ran Slither 0.11.5 against `packages/contracts`, filtered to `src/`
(test/, script/, lib/ excluded). Total: **27 findings → 1 fixed, 26
accepted false-positives**. Reproduce:

```bash
slither packages/contracts --filter-paths "test|script|lib"
```

**1 medium fixed — `reentrancy-no-eth` in `InflexionCore.settle`:**

Before the fix, `s.status = SETTLED` was written _after_ `oracle.getSettlementPrice`
and `ilMath.computeIL`. A malicious oracle or IL-math implementation
could re-enter `settle` on the same `swapId` while it was still
ACTIVE. Both are owner-deployed trusted contracts in practice, but the
hardening is essentially free.

Fix: hoisted `s.status = Status.SETTLED` to immediately after the
validity checks, before any external call. Strict CEI. Re-entry now
hits the `Status.ACTIVE` precondition and reverts. PR/commit: 5.13.

**Accepted findings (26) — disposition:**

| Detector                       | Count | Disposition                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unused-return` (medium)       | 10    | All on multi-field tuple destructuring from `NPM.positions()` (12 fields, we use 6), `Chainlink.latestRoundData()` / `getRoundData()` (5 fields, we use 2), and `Uniswap.pool.observe()` (2 fields, we use 1). Intentional + idiomatic.                                                                         |
| `reentrancy-benign` (low)      | 1     | `InflexionCore.createSwap` writes `swaps[swapId]` _after_ `underwriterVault.lockCollateral`. `lockCollateral` is an internal trusted contract that does not transfer tokens — only updates internal accounting. If it reverts the entire tx reverts, so the post-call SwapRecord write is atomic with the lock. |
| `reentrancy-events` (low)      | 4     | Events emitted after external calls in `ILVault.{claimFees, returnNFT}` and `InflexionCore.{createSwap, settle}`. Canonical Solidity pattern (event metadata depends on call results). Not a vulnerability — events are observational only.                                                                     |
| `timestamp` (low)              | 7     | Expiry / validity / staleness comparisons against `block.timestamp` in `InflexionCore` + `OracleManager`. Expected — these are time-based protocol checks where small miner-window drift (seconds) is irrelevant against our windows (minutes–hours).                                                           |
| `cyclomatic-complexity` (info) | 1     | `createSwap` has complexity 20 (Slither threshold: 11). Driven by the spec §5.2 4-phase CEI pattern with explicit per-revert custom errors. Splitting would obscure the spec-traceable structure for negligible win.                                                                                            |
| `solc-version` (info)          | 2     | `pragma solidity 0.8.24;` (exact, not range). Slither suggests using `>=0.8.0` but we pin to a specific version per project convention.                                                                                                                                                                         |
| `naming-convention` (info)     | 3     | `setCore(address _core)` / `setTreasury(address _treasury)` use leading-underscore parameter names. Project convention for setter args (avoids shadowing the storage variable).                                                                                                                                 |

**Manual review pass:** verified all I1–I9 invariants are enforced by
the code paths the tests cover (see §1). No additional findings beyond
the documented Fork-1 design observation (§3.1).

### 4.4 cvAMM contracts static analysis (Slither, P3.9)

Re-ran Slither 0.11.5 on the cvAMM additions (`ConvexityVault`, `FairValueOracle`,
`VolOracle`) + the modified `InflexionCore` (`createSwap` / `createSwapPathA` /
`createSwapRouted` + the settle dispatch). **74 results → 0 high, 0 confirmed
vulnerabilities; 1 cleanup applied** (the stray foundry-template `Counter.sol` /
`Counter.t.sol` / `Counter.s.sol` deleted — they were the only `^0.8.13` usage).
Reproduce: `slither packages/contracts --filter-paths "test|script|lib"`.

| Detector                  | Sev  | Disposition                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reentrancy-benign`       | low  | `createSwap{,PathA,Routed}` write `swaps[swapId]` _after_ `lockCollateral` + NFT `safeTransferFrom` + `accruePremium`. All callees are owner-deployed trusted contracts (ConvexityVault / UnderwriterVault, ILVault, canonical NPM); `swapId` is fresh (`nextSwapId++`) so there is no pre-existing state to corrupt, and any callee revert reverts the whole tx. |
| `reentrancy-events`       | low  | Events (`SwapCreated`/`SwapRouted`/`SwapSettled`, `ILVault.{claimFees,returnNFT}`) emitted after external calls. Observational; field values depend on call results. `settle` keeps the status-flip-first CEI from 5.13.                                                                                                                                          |
| `incorrect-equality`      | med  | `ConvexityVault` exact-zero guards (`supply==0` ⇒ first-deposit 1:1, `total==0` empty pool, `t==0`, `r.shares==0`). Control-flow guards on exact zero, not balance/threshold comparisons — not a manipulation vector.                                                                                                                                             |
| `unused-return`           | med  | Multi-field tuple destructuring: `NPM.positions()` (12→≤7), Chainlink `latest/getRoundData` (5→2), `pool.observe()` (2→1), `ConvexityVault.inventory()` (5→2: util+conc), `VolOracle.poke()` (σ_ref read separately via `fairPremium`), `FairValueOracle.fairPremium()` (fairRateWad unused). Intentional + idiomatic.                                            |
| `shadowing-local`         | low  | `IConvexityVault.inventory()` named returns mirror the same-named getters — deliberate API symmetry.                                                                                                                                                                                                                                                              |
| `timestamp`               | low  | Time-based protocol checks (validity / expiry / cooldown / staleness) + Slither lumping the `==0` guards here. Seconds-scale drift is irrelevant against minutes–hours windows.                                                                                                                                                                                   |
| `cyclomatic-complexity`   | info | `createSwap` (17), `getSettlementPrice` (12) — spec-traceable multi-phase CEI / round-walking logic.                                                                                                                                                                                                                                                              |
| `naming-convention`       | info | Leading-underscore setter args (avoid storage shadowing) + `P0/Pa/Pb` math notation in `FairValueOracle.fairRateFromPrices`. Project convention.                                                                                                                                                                                                                  |
| `unindexed-event-address` | info | `CvammConfigured(address,address,address)` — a one-time owner config event; indexing deferred.                                                                                                                                                                                                                                                                    |

**Manual review.** ConvexityVault: the junior-first-loss waterfall
(`releaseAndDistribute` caps payout at `juniorAssets`), the withdrawal cooldown +
locked/free accounting (the pool cannot be run), and `lockCollateral`'s
`lockedAfter ≤ juniorAssets` check (the `u ≤ 1−sf` senior-protection condition);
share math handles zero supply/assets. FairValueOracle / VolOracle: pure/view math

- a single permissionless `poke`; no fund custody, no reentrant surface. **The FULL
  no-bad-debt guarantee (I1) is structural and independent of these oracles** —
  `settle` caps payout at `MaxIL == collateral`. No findings beyond the documented
  design observations (§3.1). _The Stylus FairValueOracle is upstream of settle and
  is a pure pricer; its accuracy/gas record is in `docs/STYLUS_FAIRVALUE_BENCHMARK.md`._

---

## 5. Trust model (spec §4.5)

Settlement is **non-custodial** and on-chain. The off-chain matching
engine's power is strictly bounded:

| Engine CAN                                    | Engine CANNOT                                           |
| --------------------------------------------- | ------------------------------------------------------- |
| Censor / reorder quotes (liveness / fairness) | Steal funds (settlement is against MM's own collateral) |
| Pick which signed quotes to surface           | Forge quotes (every quote is MM-signed via EIP-712)     |
| Drop quotes from its book                     | Force a stale quote (validity + on-chain nonce)         |
|                                               | Bypass band check (price-band enforced on-chain)        |

**Mitigations against the powers it has** (F-#13, spec §4.5):

1. **Direct-to-contract fallback.** Any LP holding a valid signed quote
   can call `createSwap` directly, bypassing the engine. The SDK exposes
   this path — a censoring operator simply loses the user.
2. **Append-only quote log.** Engine publishes its full quote stream and
   match decisions to a rotating log (Phase 6.7).
3. **Deterministic price-time / FIFO matching rules.**

The decentralisation roadmap is an Arbitrum **Orbit chain** hosting the
quote book fully on-chain (Hyperliquid pattern) — out of hackathon scope
but the clean answer to "isn't the matcher centralised?".

---

## 6. What this document does NOT cover

- **PARTIAL mode + Insurance Fund security** — Phase 15 (stretch).
  Quant track has produced `params.json` v2.0.0 with the parameters
  Phase 15 will deploy with, but the on-chain InsuranceVault contracts
  don't exist yet.
- **Smart-contract upgradability** — there is none. All deployed
  contracts are immutable; the `setCore` + `freezeCore` pattern lets us
  one-shot wire vaults to InflexionCore and then permanently lock the
  wiring.
- **Front-end / engine security** — out of scope of this doc; covered
  in `docs/SECURITY.md` of `apps/web` and `packages/engine` (Phase 10
  / Phase 6).
