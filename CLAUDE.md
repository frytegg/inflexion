# CLAUDE.md

Project-wide guidance for Claude Code (and any teammate). Read this first.

## What this project is

**Inflexion** is a collateralized bilateral derivatives market on Arbitrum One that lets Uniswap v3 LPs pay a fixed upfront premium to transfer the _in-range_ impermanent-loss risk of a specific position to a market maker, who posts collateral and is paid for taking the risk. At expiry the protocol pays the LP their realized IL — **capped at MaxIL** — trustlessly, from the MM's collateral. In FULL mode the protocol cannot produce bad debt under its stated assumptions: capped payoff, solvent collateral asset, oracle liveness.

This is an **in-range convexity hedge**, not "IL insurance" — the cap is load-bearing for the no-bad-debt guarantee.

Built for the Arbitrum Open House London Buildathon (25 May → 14 June 2026).

## Authoritative documents — read these before changing anything

| Doc                                    | What it is                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| [`spec.md`](spec.md)                   | The protocol specification. **v4.0 FINALIZED.** Single source of truth for design. |
| [`docs/MATH.md`](docs/MATH.md)         | IL formula derivation, convexity proof, reference magnitudes.                      |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Attack vectors, mitigations, invariants.                                           |

Full protocol documentation lives in `apps/docs/` (Mintlify).

## Repo layout

```
packages/contracts/         Foundry + Stylus — all on-chain code
  stylus/FairValueOracle/   Rust Stylus contract — on-chain fair-value Φ-sum (PRODUCTION)
  stylus/ILMath/            Rust Stylus IL math — benchmark artifact (Solidity ILMath is production)
packages/engine/            Off-chain matching relayer (Node/TS)
packages/sdk/               @inflexion/sdk — LP / depositor / MM / data surfaces
packages/subgraph/          The Graph subgraph
packages/api/               Public REST API (hosted on Render)
apps/web/                   Next.js 14 frontend (App Router) — (marketing) + (app) route groups
apps/docs/                  Mintlify documentation site
quant/                      Monte Carlo calibration → params.json (the on-chain pricing parameters)
docs/                       Engineering references: MATH, SECURITY, ENGINE_TELEMETRY, STYLUS_FAIRVALUE_BENCHMARK, ACCESS_LAYER_ARCHITECTURE
scripts/                    Cross-platform helpers (.sh / .ps1 / .mjs)
deployments/                Per-network address registries (arbitrum-sepolia.json, arbitrum-one.json)
```

## Build / test / dev commands

```bash
pnpm install                 # install all workspace deps
pnpm fmt                     # prettier + forge fmt + cargo fmt
pnpm test                    # forge test + pnpm -r test
pnpm dev:node                # local Nitro fork of Arbitrum One (needs Docker)

# packages/contracts
forge test                                                    # Solidity tests
forge test --profile local                                    # vs local Nitro fork
cargo stylus check                                            # Stylus compile/type check (WSL2/Linux)
```

## Conventions

- **Solidity** 0.8.24, `via_ir = true`, optimizer 1M runs. `forge fmt`.
- **TypeScript** strict, ES2022, NodeNext, no implicit any, no unchecked indexed access. Prettier + ESLint.
- **Rust** edition 2021, rustc 1.88 (Stylus). `cargo fmt`. Stylus builds are WSL2/Linux-only on Windows.
- **Python** 3.12+, `uv` for deps, ruff for lint.

## Critical invariants — never break

From `spec.md` §13:

1. **I1 — No bad debt (FULL):** `payout ≤ collateral == MaxIL`.
2. **I2 — Cap correctness:** `payout == min(realized_IL, MaxIL)`.
3. **I3 — Non-negativity / no underflow:** `realized_IL = V_hold > V_lp ? V_hold − V_lp : 0` (never an unchecked subtraction).
4. **I4 — LP never profits from the swap:** `V_lp ≥ V_hold ⟹ payout == 0`.
5. **I5 — Vault solvency:** `locked ≤ deposited` per MM.
6. **I6 — Liquidity immutability:** settlement uses `L` **stored at creation**, never re-read from the NFT. External `increaseLiquidity` must not inflate payout.
7. **I7 — Capacity authority:** on-chain `consumedNotional[quoteId] ≤ maxNotionalV0`; a cancelled bitmap-nonce bit cannot fill.
8. **I8 — Settlement liveness (Fork 1):** `settle()` always succeeds within `expiry + LIVENESS_WINDOW + MAX_STALENESS + GRACE_PERIOD`.
9. **I9 — Band enforcement (Fork 2):** `createSwap` reverts iff `absBps(P_live, quote.quotePrice) > quote.priceBandBps`.
10. **I10 — Price cap:** `premium ≤ FairPremium · (1 + maxLoadBps)` on both rails, by construction.

Same-weight design rules:

- **`Pa ≤ P0 ≤ Pb` enforced at creation** — reject out-of-range entries.
- **No pricing constant is hardcoded.** Every load / skew / regime / cap parameter is read from `quant/params.json`, produced by the Monte Carlo calibration. Hardcoding any of these is the exact failure the audit flagged.
- **Locked collateral must stay instantly liquid.** Never route locked collateral to utilization-gated venues (Aave / Compound). Idle capital only, and only to instantly-redeemable wrappers (sDAI / tokenized T-bills).

## Workflow

- **Branches:** one per focused task. Never edit `main` directly.
- **Commits:** conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`). Imperative mood. **No co-author trailer** (project preference).
- **Push:** never `git push --force`, never `--no-verify`. If a hook fails, fix the underlying issue.
- **PRs:** even solo, open a PR for any boundary commit so the diff is reviewable.

## What NEVER to do

- **Don't edit `spec.md` to make a test pass.** Fix the code, or open a design discussion if the spec is wrong.
- **Don't fabricate external values.** Chainlink heartbeats, addresses, deviation thresholds — always verified against `data.chain.link` or canonical docs. Cite the source in the diff.
- **Don't claim "bad debt impossible" without the qualifying clause.** It is exact only under capped payoff + solvent USDC + oracle/settlement liveness + no rehypothecation breach.
- **Don't add a new mainnet address without a comment + source link** in the same diff.
- **Don't bypass the audit fixes** (storing `L`, enforcing in-range, band check, lone-spike oracle, bitmap nonce, dust floors, idle-only yield). These are not optional.
- **Don't add a "last look" path** to MM quoting. Firm quotes + oracle-band only.
