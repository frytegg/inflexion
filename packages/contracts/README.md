# @inflexion/contracts

On-chain code for Inflexion — the Foundry (Solidity) protocol plus the Arbitrum Stylus (Rust) fair-value oracle.

## What's here

- **`src/`** — the production Solidity contracts: `InflexionCore` (the two create rails + `createSwapRouted` + non-custodial `settle`), the dual-tranche `ConvexityVault` (Path-A pool), the per-MM `UnderwriterVault` (Path B), `ILVault` (position-NFT custody), `OracleManager` + `VolOracle` (Chainlink settlement price + σ_ref), `ILMath` (the production IL / MaxIL math), and the `CvammPricing` / `TickMath` / `SwapMath` / `QuoteVerification` libraries.
- **`stylus/FairValueOracle/`** — the **production** Stylus (Rust/WASM) contract: the exact closed-form fair-value Φ-sum, machine-precise where Solidity's `erf` would leak.
- **`stylus/ILMath/`** — a **benchmark artifact**, not deployed (the Solidity `ILMath` is production). See its README and [`docs/STYLUS_FAIRVALUE_BENCHMARK.md`](../../docs/STYLUS_FAIRVALUE_BENCHMARK.md).
- **`script/`** — deploy + demo-seed scripts (`Deploy.s.sol`, `SeedDemo.s.sol`, `SeedExtraTiers.s.sol`, …). Resolved addresses are written to `deployments/<network>.json`.
- **`test/`** — the Foundry suite, including the I1–I10 invariant + fuzz tests.

## Build & test (Solidity)

```bash
forge build
forge test
forge fmt
```

Solidity 0.8.24, `via_ir = true`, optimizer 1M runs.

## Building the Stylus contracts (WSL2 / Linux only)

The Stylus toolchain does **not** build on Windows MSVC: `alloy-primitives` references the VM hostio `native_keccak256`, which `link.exe` rejects as an unresolved symbol (`ld` accepts it). Build and deploy from **WSL2 / Linux**:

```bash
cd stylus/FairValueOracle    # or stylus/ILMath
cargo test                   # host-side tests (no node required)
cargo stylus check           # compile / type check
cargo stylus deploy --endpoint $RPC --private-key $DEPLOYER_PRIVATE_KEY
```

The Rust toolchain is pinned to 1.88 (see each crate's `rust-toolchain.toml`), matching cargo-stylus 0.10.x.
