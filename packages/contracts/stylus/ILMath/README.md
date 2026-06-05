# Stylus ILMath — benchmark artifact (NOT deployed)

**Status: retained, not in production.** The IL math shipped on Arbitrum Sepolia is
the **Solidity** `src/ILMath.sol` (`0x7e90…7bd2`, wired into `InflexionCore`). This
Stylus crate was built, host-tested, deployed, cached, and benchmarked — and
**kept as the benchmark artifact, not deployed into core**: even after the gas pass
below it is **cached ~20.2k vs Solidity ~4.8k (~4.18×)**. IL math is a tiny kernel,
so the Stylus per-call floor dominates and can't be amortized — the opposite of the
`FairValueOracle`, whose heavy transcendental work amortizes the floor (there Stylus
reaches gas parity and ships). See `ROADMAP.md` P2.12 and
`docs/STYLUS_FAIRVALUE_BENCHMARK.md`.

**Optimization pass (2026-06-04) — DONE.** Applied the FVO waterfall levers that
apply to a pure-integer kernel: a **U256 fast-path in `mul_div`** (the common case —
`liquidity·Δsqrt ≈ 2^156` — skips the 512-bit widening + 512-bit division entirely,
falling back to U512 only on a genuine `a·b ≥ 2^256`), `opt-level = 3` (was `"z"`),
and `#[inline]` on the hot kernel. Result: **cached ~25.5k → ~20.2k (−21%), ratio
5.33× → 4.18×**, WASM 13.4 KB. **Wei-identity preserved** — the host proptest oracle
(num-bigint, 10k+2k cases) stays green AND on-node the Stylus output equals the
deployed Solidity `ILMath` to **0 wei** across all 3 bench fixtures. As the
structural caveat predicted, a sub-5k Solidity target sits **below** the Stylus
cached call floor, so a tiny kernel cannot beat it — the win is narrowing the gap
with an honest, defensible number, not parity. **Decision: keep Solidity in
production**; this crate remains the measured-before-choosing benchmark.

Latest benchmark deployment (Arbitrum Sepolia, cached, NOT wired into core):
`0xe0528476aC37856D944dEd2811A7b1c2CC3c302C`.

**Why it's kept:** (1) it is the reproducible evidence behind the "we measured
before choosing Solidity" pitch number; (2) it is harmless — not compiled in CI
(CI runs only `forge fmt` + `forge test`), not deployed into core, cannot affect
production.

**Build/bench is WSL2-only** — the Stylus toolchain does not build on Windows
(`native_keccak256` link error in `stylus-proc`). Reproduce on the home PC:

```bash
cd packages/contracts/stylus/ILMath && cargo test          # host-side wei-identity proptest
cargo stylus deploy   --endpoint $RPC --private-key $DEPLOYER_PRIVATE_KEY --max-fee-per-gas-gwei 1 --no-verify
cargo stylus cache bid --endpoint $RPC --private-key $DEPLOYER_PRIVATE_KEY --max-fee-per-gas-gwei 0.1 <addr> 0   # cache → cached-gas number
# then (from packages/contracts): cached vs Solidity gas on-node
STYLUS_ILMATH=<addr> SOL_ILMATH=0x7e90…7bd2  PROBE=<probe> LOCAL_RPC=$RPC node script/stylus-bench.mjs
```

`$RPC` is the local Nitro dev node (`pnpm dev:node`) or any Arbitrum endpoint
(the 2026-06-04 numbers above were measured on Arbitrum Sepolia).
