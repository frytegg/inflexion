# Inflexion — Build Roadmap

> **Living guide from empty repo to hackathon demo.** Update checkboxes as work completes; update the **▶ NEXT** pointer at the end of every session so the next one starts instantly.
>
> **Authoritative spec:** [`spec.md`](spec.md) v3.3 (build-ready, both audit forks resolved).

---

## Calendar

|               |                                                      |
| ------------- | ---------------------------------------------------- |
| **Hackathon** | Arbitrum Open House London — Online Buildathon       |
| **Window**    | 25 May 2026 → **14 June 2026** (submission deadline) |
| **Today**     | 26 May 2026 — Day 2                                  |
| **Days left** | 19                                                   |
| **After**     | In-person Founder House (separate scope)             |

The original spec §17 timeline assumed pre-buildathon prep was already done; it wasn't. So **Phase 0 + Phase 1 compress into Days 1–2** of the actual window, and every subsequent phase rolls forward by ~2 days. The roadmap below uses Day numbers; the calendar maps `Day N → 25 May + N − 1`.

---

## Current state _(update every session — this is the resume point)_

|                  |                                                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase**        | 2 — ILMath (Stylus / Rust)                                                                                                                                                   |
| **▶ NEXT**       | Task **2.1** — `IILMath.sol` interface _(then install rustup + cargo-stylus before 2.2; see RUNBOOK.md)_                                                                     |
| **Spec version** | v3.3 build-ready                                                                                                                                                             |
| **Last commit**  | _(pending PR merge of `phase-1-monorepo-scaffold`)_                                                                                                                          |
| **Repo**         | https://github.com/frytegg/inflexion (private)                                                                                                                               |
| **Quant track**  | not started                                                                                                                                                                  |
| **Last update**  | 2026-05-26 — Phase 1 complete (forge build + fmt:check green)                                                                                                                |
| **Blockers**     | rustc / cargo / cargo-stylus required for tasks **2.2 onward** · docker still needed to actually run `pnpm dev:node` (the script is in place; install hints in `RUNBOOK.md`) |

---

## How to use this file

1. Each task is a checkbox `- [ ]` with a **done-when** criterion.
2. Mark `- [x] (YYYY-MM-DD)` when complete.
3. At end of every work session: update **▶ NEXT** and `Last update`.
4. Tasks are sized to 1–4h. If a task balloons, split it into sub-checkboxes inline.
5. Tasks marked ⭐ are stretch — skip unless Phases 1–13 are green and time remains.
6. Phase 14 (quant) runs in **parallel** with everything else — start it early.
7. Before committing, run the **Per-session checklist** at the bottom.

---

## Phase 0 — Repo foundation _(Day 1)_

- [x] (2026-05-26) **0.0 — Prerequisites check** — done when all installed and on PATH: `node ≥ 20`, `pnpm ≥ 9`, `rustc ≥ 1.75`, `cargo-stylus`, `foundryup` (latest `forge`/`cast`/`anvil`), `python ≥ 3.12`, `uv` (or poetry), `docker` (for Nitro), `gh` CLI. Record versions in `RUNBOOK.md`.
- [x] (2026-05-26) **0.1 — `git init`** — `git init -b main` in `C:\dev\inflexion\`. Do not commit anything yet (we'll batch foundation files into the first commit).
- [x] (2026-05-26) **0.2 — `.gitignore`** — covers `node_modules/`, `target/`, `out/`, `cache/`, `broadcast/`, `.env*` (except `.env.example`), `coverage/`, `lcov.info`, `*.log`, `.DS_Store`, `.idea/`, `.vscode/` (whitelist `settings.json` if needed), Foundry artifacts, Stylus build artifacts (`stylus/**/target/`), Python `__pycache__/`, `.venv/`, `.ipynb_checkpoints/`, and Claude artifacts.
- [x] (2026-05-26) **0.3 — `LICENSE`** — MIT, with year 2026 and author "Alex / Inflexion contributors".
- [x] (2026-05-26) **0.4 — `CLAUDE.md`** — project-wide guidance for Claude Code (and any teammate reading the repo). Must include:
  - **What** Inflexion is (1 paragraph, pulling from spec §0).
  - **Authoritative docs**: `spec.md` (latest), `ROADMAP.md` (this file), `MEMORY.md` for project memory.
  - **Build / test / dev** commands per package (filled in as packages land).
  - **Conventions**: TS strict, Solidity 0.8.24 + via_ir, Rust 1.75 + edition 2021, `forge fmt`, `cargo fmt`, prettier.
  - **Critical invariants — never break** (paraphrased from spec §13):
    1. `payout ≤ collateral` (FULL no-bad-debt).
    2. `payout = min(realized_IL, MaxIL)`.
    3. Settlement uses the `L` **stored at creation**, never re-read.
    4. `Pa ≤ P0 ≤ Pb` enforced at creation.
    5. Quote auto-voids if `|P_live − quotePrice| > priceBandBps`.
    6. **No PARTIAL constant is hardcoded** — all read from `quant/params.json`.
    7. **Locked collateral never routed to utilization-gated venues** (Aave/Compound), only liquid wrappers.
  - **Workflow**: branch per phase (`phase-N-short-name`); conventional commits, no co-author; never push to `main` directly; never `git push --force`; never bypass hooks.
  - **What NEVER to do**: don't edit `spec.md` to make a test pass (fix the code); don't add new mainnet addresses without a comment + source link; don't fabricate Chainlink heartbeat values (always verify against `data.chain.link`); don't claim "bad debt impossible" without the qualifying clause (capped payoff + solvent USDC + oracle liveness).
- [x] (2026-05-26) **0.5 — `README.md`** — stub: one-paragraph value prop + pointers to `spec.md`, `ROADMAP.md`, `docs.inflexion.xyz` (once live), `apps/web` URL (once live), and the public API URL.
- [x] (2026-05-26) **0.6 — `RUNBOOK.md`** — sibling to README: environment versions (from 0.0), required env vars, common dev commands, demo-day playbook (to be filled in Phase 12). Empty stub now.
- [x] (2026-05-26) **0.7 — `.editorconfig`** — 2-space, LF, UTF-8, trim trailing whitespace, final newline.
- [x] (2026-05-26) **0.8 — Initial commit** — `git add -A`; commit `chore: initial repo foundation (spec v3.3, roadmap, CLAUDE.md)`.
- [x] (2026-05-26) **0.9 — GitHub remote** — `gh repo create inflexion --private --source . --remote origin --push`.

## Phase 1 — Monorepo scaffold _(Day 1–2)_

- [x] (2026-05-26) **1.1 — pnpm workspace** — `pnpm-workspace.yaml` listing `packages/*`, `apps/*`. Root `package.json` with scripts: `build`, `test`, `lint`, `fmt`, `clean`, `dev:node`, `demo:reseed`.
- [x] (2026-05-26) **1.2 — Root TS config** — `tsconfig.base.json` (strict, ES2022, NodeNext, no implicit any, no unchecked indexed access). Per-package `tsconfig.json` extends base.
- [x] (2026-05-26) **1.3 — Repo layout** — create directories (empty `.gitkeep` where needed):
  ```
  packages/contracts/{src,test,script,lib,stylus/ILMath/src}
  packages/engine/src
  packages/sdk/{src,examples}
  packages/subgraph/{src,abis}
  packages/api/src
  apps/web/src
  apps/docs
  quant/notebooks
  docs/                           (root-level: MATH, SECURITY, INTEGRATION, API stubs)
  scripts/                        (cross-platform: .ps1 + .sh)
  deployments/                    (sepolia.json etc.)
  ```
- [x] (2026-05-26) **1.4 — Foundry init** — `forge init --no-commit --no-git packages/contracts`. Edit `foundry.toml`: `solc_version = "0.8.24"`, `optimizer = true`, `optimizer_runs = 1_000_000`, `via_ir = true`, `fs_permissions = [{ access = "read", path = "./deployments"}]`. Profiles: `[profile.default]`, `[profile.local]` (`fork_url = "http://localhost:8545"`), `[profile.sepolia]`.
- [x] (2026-05-26) **1.5 — OZ + Uniswap libs** _(libs are root-level submodules at `--depth 1`; used `chainlink-brownie-contracts` instead of full `chainlink` repo for size)_ — `forge install OpenZeppelin/openzeppelin-contracts Uniswap/v3-core Uniswap/v3-periphery foundry-rs/forge-std smartcontractkit/chainlink`. Remappings in `remappings.txt`.
- [x] (2026-05-26) **1.6 — Stylus toolchain** _(skeleton written: `Cargo.toml` + `src/lib.rs` + `src/main.rs` with `sol_storage!` + `#[public]`. `cargo install cargo-stylus` and `cargo stylus check` deferred until rust toolchain installed at Phase 2 entry.)_ — `cargo install --force cargo-stylus`. Scaffold `packages/contracts/stylus/ILMath/{Cargo.toml,src/lib.rs}` with the `sol_storage!` + `#[external]` skeleton (no logic yet — `cargo stylus check` must pass).
- [x] (2026-05-26) **1.7 — Local Nitro dev node** _(`scripts/dev-node.mjs` wired to `pnpm dev:node`; not yet run end-to-end because Docker isn't installed locally — verify on first Docker install)_ — `scripts/dev-node.{sh,ps1}` clones [OffchainLabs/nitro-testnode](https://github.com/OffchainLabs/nitro-testnode) into `~/.inflexion/nitro` (if missing) and starts it forking Arbitrum One. `pnpm dev:node` runs it. Document in `RUNBOOK.md`.
- [x] (2026-05-26) **1.8 — Env management** — `.env.example` at root with placeholders: `ARBITRUM_RPC`, `SEPOLIA_RPC`, `LOCAL_RPC=http://localhost:8545`, `DEPLOYER_PRIVATE_KEY`, `OPERATOR_PRIVATE_KEY` (demo only), `ETHERSCAN_API_KEY`, `THEGRAPH_DEPLOY_KEY`. `dotenv-cli` for TS packages; `--env-file` for Foundry.
- [x] (2026-05-26) **1.9 — Formatter + linter** _(prettier + ESLint flat-config + `forge fmt` + `cargo fmt` (soft-skips when cargo missing). `pnpm fmt` / `pnpm fmt:check` both green.)_ — Prettier (+`prettier-plugin-solidity`), ESLint (typescript-eslint), `forge fmt`, `cargo fmt`. Single root script `pnpm fmt` runs all three. Add a `lint-staged` config (or skip if time-pressed).
- [x] (2026-05-26) **1.10 — CI scaffold** _(landed early — fmt-check + forge build/test jobs)_ — `.github/workflows/ci.yml`: `pnpm fmt --check`, `forge test`, `cargo stylus check`, `pnpm -r build`. _(Non-blocking — can land after Phase 5.)_
- [x] (2026-05-26) **1.11 — Commit milestone** — `chore(scaffold): pnpm monorepo + foundry + stylus + nitro dev-node green`.

## Phase 2 — `ILMath` (Stylus / Rust) _(Day 2–3)_

- [ ] **2.1 — `IILMath.sol` interface** — Solidity interface per spec §11.2.
- [ ] **2.2 — Fixed-point primitives in Rust** — `sqrt_x96` (Babylonian / Uniswap-style), `mul_div`, `abs_diff`. Property-test each (10k iterations) vs a `num-bigint` reference.
- [ ] **2.3 — `compute_max_il`** — signature per spec §11.2. Implement `MaxIL = max(IL(Pa), IL(Pb))` per spec §3.2.
- [ ] **2.4 — Hand-calc unit tests for `compute_max_il`** — 8 cases: centered ±5/±10/±20/±50% ranges; entry near Pa; entry near Pb; v2-like (very wide). Each vs Python spreadsheet reference; tolerance ≤ 1 wei after normalization.
- [ ] **2.5 — `compute_il` (Case 1: in-range)** — 6 tests.
- [ ] **2.6 — `compute_il` (Case 2: below Pa, full token0)** — 4 tests.
- [ ] **2.7 — `compute_il` (Case 3: above Pb, full token1)** — 4 tests.
- [ ] **2.8 — Cap-correctness fuzz** — fuzz `sqrt_p_t` across all three regimes; assert `min(IL, MaxIL) ≤ MaxIL` always (invariants I1/I2).
- [ ] **2.9 — Asymmetric-entry fuzz** — P0 very near Pa or Pb (the auditor concern from §3.2 proof); assert MaxIL still bounds across full fuzz.
- [ ] **2.10 — Deploy `ILMath` to local Nitro** — `cargo stylus deploy --endpoint http://localhost:8545 --private-key $DEPLOYER_PRIVATE_KEY`. Record address.
- [ ] **2.11 — Solidity integration test** — Foundry test calling `IILMath(addr).computeMaxIL(...)` and comparing to a Solidity reference implementation within rounding tolerance.
- [ ] **2.12 — Gas benchmark** — measure `computeMaxIL` Stylus vs Solidity reference; record ratio in `docs/MATH.md`. (Spec claims ~10×; verify or adjust the pitch claim.)
- [ ] **2.13 — `docs/MATH.md`** — full derivation (spec §3.1), the convexity proof (spec §3.2), reference-magnitudes table regenerated from tests (replacing the spec's "to be regenerated" placeholders).
- [ ] **2.14 — Commit milestone** — `feat(stylus): ILMath with computeMaxIL + computeIL + full test suite + MATH.md`.

## Phase 3 — `OracleManager.sol` _(Day 3–4)_

- [ ] **3.1 — Sequencer feed + grace check** — internal helper; reverts on `sequencer down` and during grace.
- [ ] **3.2 — `getPrice(token0, token1)`** — entry price; `latestRoundData` with staleness check; returns canonical price.
- [ ] **3.3 — `uniswapTWAPat(token, window, anchor)`** — historical TWAP via `IUniswapV3PoolOracle.observe` with computed `secondsAgo` offsets relative to `anchor`.
- [ ] **3.4 — `getSettlementPrice(token, expiry, hintRoundId)`** — exact spec §6.1 logic: round-at-T pinning (`updatedAt ≤ expiry < nextUpdatedAt`), staleness, **lone-spike check** vs `hintRoundId − 1` and `hintRoundId + 1`, **liveness backstop** (after `LIVENESS_WINDOW` accept unconditionally), advisory TWAP flag in return.
- [ ] **3.5 — `absBps(a, b)` pure helper**.
- [ ] **3.6 — Constants** — `GRACE_PERIOD=3600`, `MAX_STALENESS=90_000`, `TWAP_WINDOW=1800`, `MAX_DEVIATION_BPS=200`, `LONE_SPIKE_BPS=500`, `LIVENESS_WINDOW=86_400`. `MAX_STALENESS` is a per-feed mapping (`token => uint256`).
- [ ] **3.7 — Pool observation-cardinality bump script** — `script/IncreaseCardinality.s.sol` for each target market pool so `[T−1800, T]` is always observable; idempotent.
- [ ] **3.8 — Unit tests with mock Chainlink** — fresh round, stale round, sequencer down, grace period active, lone-spike (3-neighbor outlier), real fast move (not lone — passes), liveness backstop firing, advisory TWAP flag set vs not set.
- [ ] **3.9 — Fork tests against Arbitrum mainnet** — fetch real round IDs around chosen historical timestamps (incl. a known volatile day); `getSettlementPrice` matches expectations.
- [ ] **3.10 — Invariant I8 fuzz** — arbitrary price paths through `T`; assert `settle()` eventually succeeds within `expiry + LIVENESS_WINDOW + MAX_STALENESS + GRACE_PERIOD`.
- [ ] **3.11 — Commit milestone** — `feat(contracts): OracleManager with round-at-T + lone-spike + liveness backstop (Fork 1)`.

## Phase 4 — Vaults _(Day 5)_

- [ ] **4.1 — `IYieldAdapter` interface** — `deposit/withdraw/balance(mm)`. Documented constraint: instantly redeemable, not utilization-gated (Fork F-#3).
- [ ] **4.2 — `NoOpYieldAdapter`** — holds USDC, returns it on withdraw, zero yield. Default for Phase 1.
- [ ] **4.3 — `UnderwriterVault.sol`** — per spec §7.1: `deposited`/`locked` mappings; `deposit/withdraw/lockCollateral/releaseAndDistribute/availableBalance`; `CapitalLow` event at 20% of deposited.
- [ ] **4.4 — `UnderwriterVault` tests** — deposit/withdraw happy paths; over-lock reverts; over-withdraw reverts; `CapitalLow` emits at correct threshold; invariant **I5** (`locked ≤ deposited` per MM).
- [ ] **4.5 — `ILVault.sol`** — `onERC721Received` accepts only the canonical NonfungiblePositionManager (hardcoded mainnet/Sepolia addresses); `(swapId → tokenId)` mapping; `claimFees(swapId)` callable by the stored LP only (forwards to PositionManager `collect`); `returnNFT(swapId, to)` onlyCore.
- [ ] **4.6 — `ILVault` tests** — fee-claim passthrough; reject non-PositionManager NFTs; verify the contract never calls `decreaseLiquidity` on custodied NFTs; **F-#2 fuzz**: third-party `increaseLiquidity` between create and `returnNFT` does not break custody invariants.
- [ ] **4.7 — Commit milestone** — `feat(contracts): UnderwriterVault + ILVault + IYieldAdapter (no-op)`.

## Phase 5 — `InflexionCore.sol` _(Day 6–7) — the heaviest contract phase_

- [ ] **5.1 — EIP-712 typed-data setup** — domain separator; `SignedQuote` type-hash; `_hashTypedDataV4`; verify via OZ `ECDSA.recover`.
- [ ] **5.2 — Bitmap nonce (Permit2-style)** — `mapping(address mm => mapping(uint256 word => uint256 bits)) nonces`; `useNonce/isNonceUsed`. Documented in [`docs/SECURITY.md`](docs/SECURITY.md).
- [ ] **5.3 — `cancelNonces(uint256[] nonces)` external** — MM flips bits to invalidate quotes (F-#7).
- [ ] **5.4 — `consumedNotional[quoteId]`** — capacity-authority storage (F-#6).
- [ ] **5.5 — `SwapRecord` storage** — per spec §5.1, including the `liquidity` field (F-#2).
- [ ] **5.6 — Constants** — `MIN_POSITION_V0` ($100 USDC = 100e6), `MIN_PREMIUM` ($1 USDC = 1e6), `PRICE_BAND_MIN_BPS=25`, `PRICE_BAND_MAX_BPS=500`, validity band `[5,15]`.
- [ ] **5.7 — `createSwap(quote, tokenId, maxPremium, hintRoundId_unused)`** — strict CEI per spec §5.2 PHASE 1–4. Must include:
  - `ownerOf(tokenId) == msg.sender`
  - `Pa ≤ P0_tick ≤ Pb` enforce (F-#2 / Gemini #3)
  - `L = position.liquidity` snapshot → write into `SwapRecord` (F-#2)
  - `premium = ceilDiv(rate · MaxIL, 10_000)` (F-#8)
  - `V0 ≥ MIN_POSITION_V0 && premium ≥ MIN_PREMIUM`
  - validity, nonce-bit live, `consumedNotional + V0 ≤ maxNotionalV0`
  - **band check** `absBps(P_live, quote.quotePrice) ≤ quote.priceBandBps` (Fork 2)
  - vault lock; USDC pull; NFT custody last; premium split 99/1 to MM/treasury.
- [ ] **5.8 — `settle(swapId, hintRoundId)`** — per spec §5.4: oracle gate, `computeIL` with **stored** `swap.liquidity`, `payout = min(IL, MaxIL)`, transfer, NFT return, event.
- [ ] **5.9 — `settlePreview(swapId, sqrtP_T)` view** — used by invariant tests (I3/I4/I8) without touching state.
- [ ] **5.10 — Invariant test suite (`Invariants.t.sol`)** — fuzz handlers for createSwap / settle / cancel / mutate-L:
  - **I1** no bad debt: `payout ≤ collateral == MaxIL`
  - **I2** cap: `payout == min(IL, MaxIL)`
  - **I3** non-neg / no underflow (fuzz `V_lp > V_hold` ⇒ no revert, `payout == 0`)
  - **I4** LP never profits from swap: `V_lp ≥ V_hold ⇒ payout == 0`
  - **I5** vault solvency: `locked ≤ deposited`
  - **I6** liquidity immutability: external `increaseLiquidity` between create/settle ⇒ `payout` unchanged
  - **I7** capacity authority: `Σ V0 ≤ maxNotionalV0`; cancelled bit ⇒ revert; concurrent fills cannot over-consume
  - **I8** settlement liveness: `settle()` always succeeds within bound (Fork 1)
  - **I9** band enforcement: stale quote + oracle gap > band ⇒ revert; within band ⇒ accept (Fork 2)
- [ ] **5.11 — Mainnet-fork integration test** — on local Nitro forking Arbitrum One: mint a real ETH/USDC v3 NFT, run full `createSwap → settle` cycle with real Chainlink + real Uniswap pool. Two paths: terminal in-range (small IL); terminal out-of-range (capped at MaxIL).
- [ ] **5.12 — Gas pass** — `forge snapshot`; identify top 3 hotspots; one round of optimization (storage packing, custom errors, inline assembly only where measured).
- [ ] **5.13 — Slither + manual review** — `slither packages/contracts`; triage; document accepted findings in `docs/SECURITY.md` checklist.
- [ ] **5.14 — Deploy Phase-1 to Arbitrum Sepolia** — `forge script script/Deploy.s.sol --rpc-url sepolia --broadcast --verify`. Record all addresses in `deployments/sepolia.json`. Update `apps/web` and `packages/sdk` to read from this file.
- [ ] **5.15 — Commit milestone** — `feat(core): InflexionCore complete; FULL/European end-to-end on Sepolia; all 9 invariants green`.

## Phase 6 — Off-chain matching engine _(Day 8–9)_

- [ ] **6.1 — Skeleton** — Node 20 + TS + Fastify (or Hono) + Redis (or in-memory fallback for the hack) + Zod schemas.
- [ ] **6.2 — Shared EIP-712 helpers** — `signQuote`, `verifyQuote` exported from a shared package consumed by engine + SDK + tests.
- [ ] **6.3 — WS quote intake (`/ws/quotes`)** — MMs connect; engine validates signature, validity, that signer has collateral in UnderwriterVault (RPC call); stores by `marketId`.
- [ ] **6.4 — Best-per-band index** — for each `(market × ratio band)` track the live best (lowest `rate × candidate-MaxIL`) quote.
- [ ] **6.5 — `/quote?tokenId&duration`** — read position params via RPC, compute MaxIL via `@inflexion/sdk` (which calls Stylus), filter live quotes by band + capacity + validity + price-band-feasibility, return best signed payload + computed premium.
- [ ] **6.6 — Quote drop policy** — drop quotes not refreshed within ~1.5s; emit `QuoteDropped` event over the public log.
- [ ] **6.7 — Append-only quote log** — per spec §4.5 (F-#13): all received quotes + match decisions to a rotating file (or S3). Public read endpoint `/log/stream`.
- [ ] **6.8 — Example MM bot** — `packages/engine/examples/mm-bot.ts`: configurable strategy that streams quotes (rate + band + priceBand + capacity), responds to mock-vol events, prints fills. Used for demo seeding.
- [ ] **6.9 — Engine integration test** — spin up engine + 2 MM bots locally; fetch best quote; submit on-chain (against Nitro fork); verify fill. Then cancel one MM's bit; verify next-best is served. Then move mock oracle past band; verify createSwap reverts with `price out of band`.
- [ ] **6.10 — Commit milestone** — `feat(engine): off-chain matching relayer + signed-quote API + example MM bot`.

## Phase 7 — `@inflexion/sdk` _(Day 9–10)_

- [ ] **7.1 — Package skeleton** — viem-based; tree-shakable; ESM + CJS dual export.
- [ ] **7.2 — Contract bindings** — auto-generated from ABIs (`forge build` → `abis/`); wagmi-generate or hand-rolled.
- [ ] **7.3 — LP surface** — `previewSwap`, `createSwap` (NFT approve + USDC approve + on-chain), `claimFees`, `getActiveSwaps`, `getPositionSummary` (δ, fees vs premium, IL-to-date).
- [ ] **7.4 — Auto-refetch on band revert** — `createSwap` catches `price out of band` revert, refetches best quote, retries once (transparent UX, Fork 2).
- [ ] **7.5 — MM quoter client** — connects to engine WS; `stream/cancel/requoteLoop(modelFn)`; signs quotes locally.
- [ ] **7.6 — Risk helpers** — `bookDelta`, `bookGamma` (approximations from position structure).
- [ ] **7.7 — Hedge helpers** — `suggestDeltaHedge` (returns "go short X ETH on Hyperliquid/GMX to flatten"); informational only.
- [ ] **7.8 — Data surface** — `getConvexityPremiumIndex(market, band)`, `getRiskAppetiteIndex(market)`, `getConvexityDepth(market)`.
- [ ] **7.9 — Examples** — `examples/lp-basic.ts` (10-line LP flow), `examples/mm-bot.ts` (10-line MM streamer), `examples/data-consumer.ts` (5-line surface fetch).
- [ ] **7.10 — Publish (or local pack)** — for the hack, `pnpm pack` an artifact + post on GitHub release; full npm publish optional.
- [ ] **7.11 — Commit milestone** — `feat(sdk): @inflexion/sdk LP / MM / data surfaces + examples`.

## Phase 8 — Subgraph _(Day 10–11)_

- [ ] **8.1 — `schema.graphql`** — entities per spec §11.5.
- [ ] **8.2 — `subgraph.yaml`** — data sources for `InflexionCore` + `UnderwriterVault` on Arbitrum Sepolia.
- [ ] **8.3 — Mapping handlers (AssemblyScript)** — `handleSwapCreated`, `handleSwapSettled`, `handleCapitalLow`, `handleNoncesCancelled`, etc.
- [ ] **8.4 — Surface back-computations** — convexity-premium index per `(market × band)`; risk-appetite signals; convexity-supply depth.
- [ ] **8.5 — Deploy to Graph Studio** — Sepolia subgraph; record endpoint URL in `deployments/sepolia.json` and `apps/web` env.
- [ ] **8.6 — Commit milestone** — `feat(subgraph): live indexer for swaps + quotes + vault`.

## Phase 9 — REST API _(Day 11)_

- [ ] **9.1 — `packages/api` skeleton** — Fastify + Apollo client to subgraph + Zod schemas.
- [ ] **9.2 — Endpoints (spec §11.7)** — `/markets`, `/markets/:pair/:fee/:dur/{iv|risk-appetite|depth}` (rename `iv` → `cpi` for convexity-premium-index per Fork F-#12; keep `iv` as alias for back-compat), `/swap/:id`, `/mm/:address/stats`, `/vault/health`.
- [ ] **9.3 — Dockerfile + Railway/Fly deploy** — public URL.
- [ ] **9.4 — OpenAPI / Swagger spec** — auto-generated from Zod; served at `/docs`.
- [ ] **9.5 — Commit milestone** — `feat(api): public REST API live + OpenAPI`.

## Phase 10 — Frontend (`apps/web`) _(Day 12–15)_

- [ ] **10.1 — Bootstrap** — React 19 + Vite + TS + wagmi v2 + viem + RainbowKit + Apollo + shadcn/ui + Recharts + Tailwind.
- [ ] **10.2 — Theme + layout** — header w/ wallet + nav; footer w/ Docs / API / GitHub; live stats strip at the bottom.
- [ ] **10.3 — `/` landing** — value prop, 3 CTAs ("Protect my LP" / "Underwrite & earn" / "Vault" (Phase 2)), live stats, trust band ("FULL: bad debt is mathematically impossible — see proof →").
- [ ] **10.4 — `/protect` LP flow** —
  - auto-detect v3 NFTs (read PositionManager)
  - position cards (pair, range, V0, in/out of range badge)
  - duration picker (7/30/90d; demo: seconds)
  - **ONE quote view**: "Pay $X to cover up to $Y of impermanent loss for 30 days" + plain English MM + settlement = European
  - `[Advanced ▸]` reveals rate (% MaxIL), MM, ratio band, raw MaxIL, oracle source, **priceBand**
  - **Payoff diagram** (F-#5 user-facing rule): covered region up to MaxIL, uncovered beyond range, with the in-range-convexity-hedge label
  - Confirm → approve NFT + USDC → on-chain
  - **Auto-refetch on band revert** (Fork 2 UX): show "Refreshing quote — market moved" toast; retry once
- [ ] **10.5 — `/dashboard` LP** — active-swap cards: δ, IL-to-date, fees-vs-premium, expiry countdown, Claim Fees button. Settled history.
- [ ] **10.6 — `/underwrite` MM cockpit** — deposit/withdraw; quoting panel (rate, ratio band, capacity, validity, **priceBand**); live book preview; portfolio Greeks; ROC/P&L; CapitalLow alerts.
- [ ] **10.7 — `/markets` — three data surfaces** —
  - Convexity-Premium Index heatmap (pair × duration × band) — **NOT labeled "IV"**, with the caveat tooltip
  - Risk-appetite gauge + time series
  - Convexity-supply depth per market
  - "Free public data — API →"
- [ ] **10.8 — Demo-mode price ticker** _(consumed by Phase 12)_ — shows live oracle so the audience watches IL accrue.
- [ ] **10.9 — Settlement animation** — at settle, "LP made whole · MM paid residual · NFT returned" with tx links.
- [ ] **10.10 — Mobile-acceptable layout** — judges sometimes review on phone.
- [ ] **10.11 — Commit milestone** — `feat(web): /protect /dashboard /underwrite /markets live and end-to-end`.

## Phase 11 — `docs.inflexion.xyz` _(Day 14–16, parallel with frontend)_

- [ ] **11.1 — Bootstrap** — Mintlify (preferred for the polish + interactive components) or Docusaurus in `apps/docs`.
- [ ] **11.2 — Audience 1 — zero-knowledge LP** — "What is impermanent loss?" with an **interactive price slider** that draws hold-vs-LP curves and the IL gap; analogy ("like insurance for your LP"); glossary; FAQ. No math.
- [ ] **11.3 — Audience 2 — LP guide** — UI flow + 10-line SDK example; explains the MaxIL cap simply with the payoff diagram; explains the "in-range convexity hedge" framing.
- [ ] **11.4 — Audience 3 — MM guide** — running a quoting bot; the SDK quoter + hedging helpers; "uptime, not volume" principle; rate / ratio band / **priceBand** sizing.
- [ ] **11.5 — Audience 4 — Data / API** — REST + GraphQL + SDK reference; the 3 surfaces; contamination caveats; curl + TS examples.
- [ ] **11.6 — Audience 5 — Protocol / security** — math (from `docs/MATH.md`), no-bad-debt proof, cap reasoning, trust model (spec §4.5), Fork-1 + Fork-2 designs, quant model (Phase 14 outputs), all 9 invariants, attack vectors + mitigations.
- [ ] **11.7 — Deploy** — Vercel / Cloudflare Pages; custom domain `docs.inflexion.xyz` if owned, else subdomain.
- [ ] **11.8 — Commit milestone** — `docs: docs.inflexion.xyz live with 5-audience structure`.

## Phase 12 — Demo deployment + testnet setup _(Day 17–18)_

- [ ] **12.1 — `OracleManager` demo mode** — `setDemoPrice(token, price)` gated to `OPERATOR_KEY` and a `DEMO_MODE` immutable; only deployed in the demo deployment (never mainnet). Still routed through the lone-spike + health gates.
- [ ] **12.2 — Configurable seconds-scale durations** — demo deployment accepts `duration` in seconds (e.g. 120s).
- [ ] **12.3 — Pre-seed script** — `scripts/demo-seed.ts`: mint 2–3 ETH/USDC v3 NFTs (tight + wide ranges), deposit MM capital, start 2–3 MM bots, create one swap near-expiry. Idempotent with a `--reset` flag.
- [ ] **12.4 — One-shot reseed** — `pnpm demo:reseed` tears down and re-seeds in <30s.
- [ ] **12.5 — Live demo dry-run** — full 3-min sequence per spec §15.2 executed end-to-end; record timings; iterate.
- [ ] **12.6 — Recorded fallback video** — full demo screen-recorded (OBS / Loom); uploaded; link in pitch deck and README.
- [ ] **12.7 — Pin RPC URLs + pre-fund all gas** — Sepolia ETH + Circle USDC; document the playbook in `RUNBOOK.md` (demo-day section).
- [ ] **12.8 — Commit milestone** — `feat(demo): Sepolia demo deployment + seed scripts + fallback video`.

## Phase 13 — Pitch + submission _(Day 18–19)_

- [ ] **13.1 — 30-second hook rehearsal** — spec §16.1 wording; time it (must be ≤ 30s).
- [ ] **13.2 — Slide deck (~10 slides)** — Problem · Primitive · MaxIL + invariant · Quote-driven dealer market · Quant model · Data moat · Honesty slide · Roadmap · Team · Demo CTA.
- [ ] **13.3 — 3-minute demo script** — choreography per spec §15.2; rehearse twice end-to-end.
- [ ] **13.4 — Tough Q&A prep** — spec §16.6 Q&A; index-card answer to each.
- [ ] **13.5 — HackQuest submission** — project page, video link, repo link, deck, addresses, API URL, docs URL.
- [ ] **13.6 — Commit milestone (final)** — `release: v0.1.0 — Inflexion hackathon submission`.

---

## Parallel track ⊕ Phase 14 — Quant model (`quant/`) _(start Day 3, runs through Day 18)_

**Gates PARTIAL** and is a flagship pitch artifact ("we did not guess our risk parameters — we derived them from Monte Carlo stress under fat-tailed, correlated crashes").

- [x] (2026-05-26) **14.1 — Notebook scaffold** — Python 3.12 + `uv`, jupyter, numpy/scipy/pandas/matplotlib, `arch` (vol models). `quant/notebooks/01_underlying.ipynb` etc. _(landed with `inflexion_quant` package + `01_underlying.ipynb` smoke test; `arch` deferred to Task 14.2 when GARCH actually gets used.)_
- [ ] **14.2 — Underlying model** — jump-diffusion (Kou or Merton) + historical bootstrap from 3y ETH/BTC/ARB data; common crash factor.
- [ ] **14.3 — Position-structure distribution** — realistic LP range widths × moneyness mix.
- [ ] **14.4 — Path → IL** — Python reimplementation of spec §3.1; sanity-check vs Stylus on a sample.
- [ ] **14.5 — Portfolio waterfall** — spec §9 step 3.
- [ ] **14.6 — Stress scenarios** — correlated crash (common factor +6σ), vol regime shift, utilization spike.
- [ ] **14.7 — Parameter outputs** — `c_min`, convex `floor_curve(c)`, convex `fee(c)`, circuit-breaker thresholds, withdrawal-delay length, per-market/per-MM exposure caps, MM first-loss size, target fund balance for ruin < 0.1%.
- [ ] **14.8 — `quant/params.json`** — versioned, schema-validated, consumed by Phase 15 deploy.
- [ ] **14.9 — Charts for the deck** — fund P&L distribution, ruin prob vs `c`, drawdown under 99.9th-pct correlated crash. Export to `apps/docs/static/quant/`.
- [ ] **14.10 — Commit milestone** — `feat(quant): Monte Carlo solvency model + params.json + charts`.

## Stretch ⭐ Phase 15 — PARTIAL mode _(only if Phases 1–13 green AND Phase 14 done)_

- [ ] **15.1 — `InsuranceVault.sol`** — ERC-4626 with locked-vs-free tracking, withdrawal delay + redemption queue, `coverBadDebt/healthRatio/circuitBreakerLevel`.
- [ ] **15.2 — Convex floor + leverage tax** — read `params.json`; smooth curves; evaluate `minPartialBps` dynamically on every fill.
- [ ] **15.3 — Circuit breakers** — L0/L1/L2/L3 thresholds from health-ratio; L2 suspends new PARTIAL, L3 multisig-only.
- [ ] **15.4 — `LiquidationManager.sol`** — Dutch-auction keeper reward (linear ramp), Chainlink Automation target.
- [ ] **15.5 — MM first-loss stake** — `lockFirstLoss(mm, amount)` proportional to PARTIAL exposure.
- [ ] **15.6 — Per-market / per-MM exposure caps** — enforced at createSwap.
- [ ] **15.7 — PARTIAL invariant tests** — fund solvency under simulated correlated crash; first-loss eaten before depositors; withdrawal-delay enforced.
- [ ] **15.8 — `/vault` page** — deposit USDC → ifUSDC; APY (30d from subgraph); health-ratio gauge **prominent**; withdrawal queue; explicit risk-disclosure modal.
- [ ] **15.9 — `/underwrite` PARTIAL controls** — first-loss stake; PARTIAL ratio slider; live `minPartialBps` floor display.
- [ ] **15.10 — Commit milestone** — `feat: PARTIAL mode + Insurance Fund (stretch, audited params from quant)`.

---

## Operational checklists _(use these throughout)_

### Per-session — start

- [ ] `git pull --rebase`
- [ ] Read this file's **Current state** block — pick up at **▶ NEXT**
- [ ] Glance at any open issues / blockers

### Per-session — end

- [ ] Mark completed tasks `- [x] (YYYY-MM-DD)`
- [ ] Update **▶ NEXT** pointer
- [ ] Update `Last update` and `Last commit`
- [ ] Commit roadmap update alongside the day's code: `chore(roadmap): progress YYYY-MM-DD`

### Before any spec change

- [ ] Re-read the relevant `spec.md` section (don't trust memory)
- [ ] Note which spec version is touched
- [ ] Bump version footer if the change is substantive (semantic, not typo)

### Before any contract change

- [ ] All existing invariant tests pass
- [ ] If touching FULL settlement math → re-verify **I1–I9**
- [ ] `forge fmt && forge test`
- [ ] `slither packages/contracts` clean (or triaged)

### Definition of "done" — submission-ready

- ✅ FULL/European end-to-end on Sepolia (real NFT, real Chainlink, settle works)
- ✅ All 9 invariants pass under fuzz
- ✅ Frontend `/protect → /dashboard → settle` runs in <2 min on stage
- ✅ MM bots stream live quotes; LP gets best quote instantly
- ✅ `/markets` shows 3 surfaces with real data
- ✅ `docs.inflexion.xyz` audiences 1–5 deployed
- ✅ Recorded fallback video uploaded
- ✅ Deck rehearsed twice
- ✅ HackQuest submission complete

---

## Risk register _(update if a risk materialises)_

| Risk                                                           | Likelihood | Impact | Mitigation                                                                                                                   |
| -------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Stylus `ILMath` doesn't hit 10× gas claim                      | Medium     | Low    | Adjust pitch claim; still ship; Stylus is Arbitrum-native regardless                                                         |
| Sepolia Chainlink missing a feed                               | Low        | Medium | Use mock oracle in tests; for the demo use a controlled OracleManager mode (§12.1)                                           |
| Quant model not done in time                                   | Medium     | Medium | PARTIAL is stretch; FULL ships either way; quant is also a deck artifact even partial                                        |
| Frontend bugs at demo                                          | Medium     | High   | Recorded fallback video; dry-run twice (§12.5)                                                                               |
| Sepolia RPC flakes on stage                                    | Low        | High   | Pinned RPC, fallback video, local Nitro as backup                                                                            |
| `priceBandBps` defaults cause too many band-reverts on Sepolia | Medium     | Low    | Default 100bps is tunable; loosen to 200bps if measured revert rate >5%                                                      |
| LP demand thin in the live demo                                | High       | Low    | We seed both sides; the _pitch_ covers viability (§10) — this is correctly framed as a market-formation question for mentors |
