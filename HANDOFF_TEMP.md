# HANDOFF (temporary — delete after both items are done)

Two tasks for the home PC (WSL2/Nitro). Created 2026-06-04. Delete this file once
both are complete.

---

## A. Settle the residual Sepolia demo swap #1 (on/after June 11)

**Context.** Swap #1 is the leftover 7-day Path-A smoke-test position on the live
Arbitrum Sepolia deployment (V0 ≈ $120,351, MaxIL = collateral = $706.29). It was
created June 3 on `marketId_fee500_7d` and **expires ~June 10** — `settle()` reverts
`NotYetExpired` before then, so it can only be settled on/after June 10 (target
June 11 for margin + bracketing Chainlink rounds). Settling releases the pooled
collateral, returns the NFT, and is the final P3 cleanup.

> The in-session scheduler reminder is **session-only** (won't survive the laptop's
> Claude session closing), so treat this file as the source of truth.

**Addresses** (`deployments/arbitrum-sepolia.json`):

- InflexionCore: `0x15b74EfcAB40A08281C0Cea972BeE0bbA1a9A96d`
- Chainlink ETH/USD (Sepolia): `0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165`
- LP NFT tokenId: `3174` · swapId: `1`

**Steps.** `settle` is **permissionless** — any funded key works.

```bash
# 1. read the swap's expiry (field 11 of the SwapRecord tuple)
cast call 0x15b74EfcAB40A08281C0Cea972BeE0bbA1a9A96d "swaps(uint256)" 1 --rpc-url $SEPOLIA_RPC

# 2. find the Chainlink ETH/USD round whose updatedAt brackets that expiry
#    (walk back from latestRound; same algorithm as test/_findRoundAt in the fork suites):
cast call 0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165 "latestRoundData()" --rpc-url $SEPOLIA_RPC
#    -> step roundId down until updatedAt <= expiry < nextRound.updatedAt; that roundId = <hintRound>

# 3. settle
cast send 0x15b74EfcAB40A08281C0Cea972BeE0bbA1a9A96d "settle(uint256,uint80)" 1 <hintRound> \
  --rpc-url $SEPOLIA_RPC --private-key $KEEPER_KEY
```

**Verify after:** NFT 3174 back with the LP, ConvexityVault `totalLocked` decreased
by MaxIL, swap status = SETTLED, payout = `min(realisedIL, MaxIL)` (likely small or
0 if price stayed near entry). Then tick **all of P3** done in `ROADMAP.md`
(P3.11 milestone + section) and bump ▶ NEXT to P4.

---

## B. Try to optimize the Stylus ILMath (`stylus/ILMath/src/math.rs`)

**Goal.** See whether the FairValueOracle optimization waterfall can drive the
Stylus ILMath cached gas **below the Solidity ILMath (~4.8k)**. If yes, swap the
deployed `ilMath` to the Stylus contract via `InflexionCore` wiring; if no, keep
Solidity and record the honest number. (Current: Stylus ~25.5k cached vs Solidity
~4.8k, ~5.3× — `ROADMAP.md` P2.12.)

**Expectation (be honest in the writeup):** unlike the FairValueOracle (heavy
transcendental compute that amortized the Stylus call floor → reached parity),
ILMath is a tiny kernel, so a large share of the 25.5k is likely the Stylus
per-call base overhead, not reducible compute. Beating Solidity's 4.8k is
structurally hard. The value of the pass is (a) narrowing the gap and (b) a clean,
defensible pitch number either way.

**Concrete levers (in priority order), from `docs/STYLUS_FAIRVALUE_BENCHMARK.md` §4:**

1. **Kill the blanket U512 in `mul_div`** (the biggest lever — this is exactly the
   anti-pattern the FVO doc flagged: "Avoid U512 / byte-copy widening; keep
   everything in U256"). `math.rs::mul_div` widens every product to 512 bits via
   byte-buffer copies (`to_u512`/`from_u512` use `to_be_bytes`/`from_be_bytes`) and
   does a **512-bit division** — the dominant cost ("division is ~8× a multiply").
   But `computeMaxIL` runs ~13 `mul_div` calls, and most products fit U256
   (`liquidity·Δsqrt ≈ 2^156 < 2^256`). Add a **U256 fast-path**: if
   `a.checked_mul(b)` doesn't overflow, do `a*b/denom` in U256; fall back to U512
   only on overflow. This removes ~all 512-bit divisions + byte copies on the
   common path.
2. **Replace the byte-buffer widening** (`to_be_bytes` → `from_be_bytes`) with
   direct alloy widening (`U512::from(x)` / `.to::<U512>()`), even on the fallback
   path — no heap/byte-copy.
3. **`opt-level=3` + fat-LTO + `#[inline]`** on `mul_div`, `amounts_at`,
   `amount0_in_token1`, `v_lp`, `il_at` (the FVO got its single biggest jump,
   146k→66k, from this). Check `Cargo.toml` `[profile.release]`.
4. **Confirm dead code is stripped:** `integer_sqrt`, `sqrt_price_x96`, `abs_diff`
   are `#[allow(dead_code)]` host-only (the contract takes `sqrtPriceX96` as input)
   — LTO should already drop them from the WASM; verify with the size.

**HARD CONSTRAINT — preserve wei-identity.** The Stylus impl must stay
**wei-identical to `src/ILMath.sol`** (the Task 2.11 cross-check). The Solidity does
the exact same two-step floor `mul_div` chain, so do NOT algebraically fold/cancel
divisions (e.g. the `·q then /q` in `amounts_at`) — that changes the floor rounding
and breaks the cross-check. The levers above (U256 fast-path, direct widening,
inline, opt-level) all preserve the exact arithmetic; only execution speed changes.
Re-run `cargo test` (the `num-bigint`/`proptest` oracle, 10k+2k cases) after every
change to prove wei-identity holds.

**Build + bench (WSL2 only — Stylus doesn't build on Windows):**

```bash
cd packages/contracts/stylus/ILMath
cargo test                              # wei-identity proptest oracle (must stay green)
cargo stylus check                      # activation / float-ban check
cargo stylus deploy --endpoint $LOCAL_RPC --private-key $DEPLOYER_PRIVATE_KEY --no-verify
cargo stylus cache bid --endpoint $LOCAL_RPC --private-key $DEPLOYER_PRIVATE_KEY <addr> 0
cd ../.. && STYLUS_ILMATH=<addr> DEPLOYER_PRIVATE_KEY=… LOCAL_RPC=… node script/stylus-bench.mjs
```

**Decision rule:** record the new cached gas vs Solidity in `ROADMAP.md` P2.12 +
`stylus/ILMath/README.md`. If Stylus < Solidity, deploy it and repoint
`InflexionCore.ilMath`; else keep Solidity (production) and keep the crate as the
documented benchmark artifact.
