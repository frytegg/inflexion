# Stylus ILMath — benchmark artifact (NOT deployed)

**Status: retained, not in production.** The IL math shipped on Arbitrum Sepolia is
the **Solidity** `src/ILMath.sol` (`0xC203…`, wired into `InflexionCore`). This
Stylus crate was built, host-tested, deployed to a local Nitro node, and
benchmarked — and **rejected on gas**: cached ~25.5k vs Solidity ~4.8k (~5.3×
worse). IL math is a tiny kernel, so the Stylus per-call floor (~25k) dominates and
can't be amortized — the opposite of the `FairValueOracle`, whose heavy
transcendental work amortizes the floor (there Stylus reaches gas parity and
ships). See `ROADMAP.md` P2.12 and `docs/STYLUS_FAIRVALUE_BENCHMARK.md`.

**Why it's kept:** (1) it is the reproducible evidence behind the "we measured
before choosing Solidity" pitch number; (2) it is harmless — not compiled in CI
(CI runs only `forge fmt` + `forge test`), not deployed, cannot affect production.

**Open investigation:** whether the FairValueOracle optimization waterfall
(1e24/U256 fixed-point, `opt-level=3` + `#[inline]`, division-folding,
Clenshaw-rational tails — `docs/STYLUS_FAIRVALUE_BENCHMARK.md` §4) can drive this
below Solidity's ~4.8k. Note the structural caveat: a sub-5k Solidity target is
below the Stylus cached call floor, so parity here is **not** guaranteed the way it
was for the compute-heavy FVO. If a future pass does beat Solidity, swap the
deployed ILMath for this crate via `InflexionCore`'s `ilMath` wiring.

**Build/bench is WSL2-only** — the Stylus toolchain does not build on Windows
(`native_keccak256` link error in `stylus-proc`). Reproduce on the home PC:

```bash
cd packages/contracts/stylus/ILMath && cargo test          # host-side proptest
cargo stylus deploy --endpoint $LOCAL_RPC --private-key $DEPLOYER_PRIVATE_KEY --no-verify
# then: STYLUS_ILMATH=<addr> node ../../script/stylus-bench.mjs   # on-node gas vs Solidity
```
