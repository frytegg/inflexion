# 09 — Reference: Deployment, Markets, Decimals, Env, Glossary

> Source-material knowledge dump for the public docs + the founder's judge Q&A.
> Every technical claim is cited `file:line` against the repo at commit `3527254`
> (branch `main`, 2026-06-09). Live network: **Arbitrum Sepolia (chainId 421614)**,
> full-fresh redeploy **2026-06-05**. Numbers and addresses are NOT invented — they
> are read out of `deployments/arbitrum-sepolia.json`, the contracts, and the SDK.
> Where something is uncertain or pending it is explicitly flagged.

---

## 1. Live deployment table (Arbitrum Sepolia, chainId 421614)

All addresses below come from `deployments/arbitrum-sepolia.json` (the single
source of truth — the SDK loads them and hardcodes nothing:
`packages/sdk/src/addresses.ts:10`). Deployer / treasury EOA:
`0x96455C9b00D530BD0629b71B674298440328b1Dd`
(`deployments/arbitrum-sepolia.json:39`).

**Deploy block `274081134`** — this is the subgraph `startBlock`; the on-chain
moat dataset begins here (`deployments/arbitrum-sepolia.json:40`,
`:41`). The 2026-06-05 deploy is a FULL-FRESH redeploy that replaced the
2026-06-03 stack so a fresh Stylus FairValueOracle could be `init()`-bound to the
fresh VolOracle (the FVO's `init()` is set-once; reusing the old FVO would have
orphaned the new vol's σ_ref — `deployments/arbitrum-sepolia.json:41`,
`:46`; `packages/contracts/stylus/FairValueOracle/src/lib.rs:92`).

### Core protocol (Solidity stack — `deployment.core`)

| Contract | Address | Role | Source |
| --- | --- | --- | --- |
| **InflexionCore** | `0xC19865cF8403F59B8Eca835833aFEe3Aa8DA4848` | State machine. `createSwapPathA` / `createSwap` (Path B) / `createSwapRouted`; enforces I1–I10; CEI settlement. Also the EIP-712 `verifyingContract` for signed quotes. | `arbitrum-sepolia.json:49`; `spec.md:974` |
| **OracleManager** | `0x2c18147B6ec75dcb330d9A48B6B96a4d1a8b529b` | Chainlink-anchored entry/settlement price + sequencer + staleness + lone-spike + Uniswap-TWAP advisory. `getPrice` (entry) / `getSettlementPrice` (settle). Reverts on stale feed / sequencer down. | `arbitrum-sepolia.json:50`; `spec.md:964` |
| **VolOracle** | `0xfdEafBB381192FC5337499d041eaead04d565Ed9` | `σ_ref = max(σ_short, σ_long, floor)`, a poke-based time-aware EWMA of Chainlink-tick log-returns. Never raw realized σ. | `arbitrum-sepolia.json:51`; `VolOracle.sol:28` |
| **ILMath** | `0x7e90362bc6Df9cb5faA13952e07853ab16c77bd2` | **PRODUCTION** settle-path math (Solidity). `computeMaxIL` / `computeIL` / `getAmountsForLiquidity` — pure Q64.96 fixed-point. The on-chain contract that computes IL at settlement. | `arbitrum-sepolia.json:52`; `spec.md:948` |
| **ILVault** | `0x9f7615Aca943832977CEf3ac1862fD48B87b7664` | ERC-721 custody of the LP's Uniswap v3 position NFT during an active swap; reads NPM; `claimFees` passthrough. | `arbitrum-sepolia.json:53`; `spec.md:973` |
| **UnderwriterVault** | `0x4Fb459F3393D206c2b7faD7f0fC9C35a78348D64` | Per-MM collateral home for **Path B** (`deposited` / `locked` / `available`). `lockCollateral` / `releaseAndDistribute` (onlyCore). | `arbitrum-sepolia.json:54`; `spec.md:972` |
| **ConvexityVault** | `0xDE2fFeBA2E6A18f3A53D43EC0fCCD299158eC30d` | The cvAMM pooled underwriter for **Path A**. USDC ERC-4626, **DUAL-TRANCHE SENIOR/JUNIOR from launch**. One per pair, backs all 9 markets with fungible capital. | `arbitrum-sepolia.json:55`; `spec.md:965` |
| **Treasury** | `0x96455C9b00D530BD0629b71B674298440328b1Dd` | Protocol treasury (takes the 1% premium cut). Same EOA as the deployer on this testnet. | `arbitrum-sepolia.json:56` |

### Stylus contract (the production fair-value pricer)

| Contract | Address | Role | Source |
| --- | --- | --- | --- |
| **FairValueOracle (Stylus, Rust/WASM)** | `0x98a6aa75108b70fc0794bc3b87efe0ae99d5d52c` | **PRODUCTION.** Exact closed-form `fairRate` Φ-sum → `FairPremium = fairRate · MaxIL`. Machine-precise to ≤ 1e-12 (≈6.7e-15 cited in spec). `fairRate` / `fairRateFromPrices` / `fairPremium` / `volOracle`. **NEVER reimplemented off-chain** (CLAUDE.md hard rule). | `arbitrum-sepolia.json:43`; `FairValueOracle/src/lib.rs:1`; `spec.md:959` |

- Activation tx: `0x8fc48dc62c0a99ad636301a008fba5bbd02e84e85d6abb373aa2767572d55a6c`; runtime `21702` bytes (`arbitrum-sepolia.json:44`–`46`).
- Stylus bans WASM floating point at activation, so every transcendental (erf/Φ, exp, ln, sqrt) is **integer fixed point** (1e24 internal, WAD 1e18 ABI) — `FairValueOracle/src/lib.rs:13`, `fairrate.rs:6`.
- The Solidity `src/FairValueOracle.sol` exists ONLY as a revm-testable CI cross-check, **not** a second production oracle (`spec.md:962`).

### Deployed Solidity libraries (public functions, delegatecall image)

Auto-deployed + linked by `forge` during the `Deploy.s.sol` broadcast
(`arbitrum-sepolia.json:59`). **Important quirk:** these deployed libraries are
**DELEGATECALL-ONLY** — a direct `eth_call` to them reverts (Solidity guards
deployed library functions), so the SDK keeps a parity-locked TS mirror of the
load math instead of reading them (`packages/sdk/src/math.ts:7`).

| Library | Address | Role |
| --- | --- | --- |
| **TickMath** | `0xbf02bbc82e0fb1a4b9828bb90fc9dd9e97578965` | tick → sqrtPriceX96 (pure). `arbitrum-sepolia.json:60` |
| **CvammPricing** | `0x4a053d29a55a64172140f9ebbc27c321c0ba2b53` | The deployed load stack (`totalLoadWad` / `loadComponents` — base/util/disp/total). `arbitrum-sepolia.json:61` |
| **SwapMath** | `0xf7be9745b6768d06a18c386c6db5c8cb065ba314` | Entry token amounts + oracle→sqrtP conversion (pure). `arbitrum-sepolia.json:62` |
| **QuoteVerification** | `0x74819eed322f3e1a2dc10bb0d3cae50078d90807` | EIP-712 quote hashing / signature check. `arbitrum-sepolia.json:63` |
| *(Gaussian)* | linked-in | Φ/erf for the Solidity CI cross-check FVO; not separately addressed in the registry (`spec.md:977`). |

### Uniswap v3 (Arbitrum Sepolia)

Verified 2026-05-28, re-confirmed 2026-06-03 (`arbitrum-sepolia.json:23`).

| Contract | Address |
| --- | --- |
| v3 Factory | `0x248AB79Bbb9bC29bB72f7Cd42F17e054Fc40188e` |
| NonfungiblePositionManager (NPM) | `0x6b2937Bde17889EDCf8fbD8dE31C3C2a70Bc4d65` |
| SwapRouter02 | `0x101F443B4d1b059569D643917553c771E1b9663E` |
| QuoterV2 | `0x2779a0CC1c3e0E44D2542EC3e79e3864Ae93Ef0B` |

The protocol's NFT custody (ILVault) reads `positions(tokenId)` from this NPM
(`packages/sdk/src/addresses.ts:70`).

### Chainlink USD price feeds (8-decimal)

Verified 2026-05-28 against the Chainlink reference-data directory
(`arbitrum-sepolia.json:6`).

| Feed | Address | Heartbeat (testnet) |
| --- | --- | --- |
| ETH/USD | `0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165` | ~120s |
| BTC/USD | `0x56a43EB56Da12C0dc1D972ACb089c06a5dEF8e69` | ~120s |
| ARB/USD | `0xD1092a65338d049DB68D7Be6bD89d17a0929945e` | 86,400s |
| USDC/USD | `0x0153002d20B96532C639313c2d54c3dA09109309` | 86,400s |
| **Sequencer Uptime** | **`null`** (none on Sepolia) | — |

- Chainlink does NOT publish an L2 Sequencer Uptime Feed on Arbitrum Sepolia
  (testnet, no SLA). `OracleManager` treats `sequencerFeed == address(0)` as
  "skip sequencer check" — safe on testnet, **but must be set before any mainnet
  deploy** (`arbitrum-sepolia.json:11`–`12`).
- Testnet feeds tick faster (~120s) than mainnet (86,400s), but
  `OracleManager.MAX_STALENESS` is set to **90,000s** so the same value works on
  either chain (`arbitrum-sepolia.json:13`–`19`).
- The demo's dWETH is **oracle-priced via the real Chainlink ETH/USD feed**
  (`arbitrum-sepolia.json:66`).

### Real Arbitrum One reference feeds + Uniswap (for the eventual mainnet)

These are the **mainnet** values cited in the spec (not the live testnet
deployment) — they appear in the docs for completeness/migration:

- ETH/USD `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612`, BTC/USD `0x6ce185539ad4fdaecd7274c0b0c9fc4add7c4e76`, ARB/USD `0xb2A824043730FE05F3Da2efaFa1CBbe83fa548D7`, USDC/USD `0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3`, Sequencer `0xFdB631F5EE196F0ed6FAa767959853A9F217697D` (`spec.md:636`).
- NPM `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`, v3 Factory `0x1F98431c8aD98523631AE4a59f267346ea31F984`, WETH `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`, native USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` (`spec.md:985`).

### Canonical tokens on Arbitrum Sepolia (the "real" testnet tokens)

These exist but are NOT what the live markets use — there is no pre-seeded
WETH/USDC v3 pool with material liquidity on Sepolia, so the demo deploys its own
mock pair (see §1.1). (`arbitrum-sepolia.json:30`–`35`.)

- WETH `0x980B62Da83eFf3D4576C647993b0c1D7faf17c73` (18 dec)
- USDC (Circle native testnet) `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` (6 dec)

### 1.1 The demo pair / pool / LP position

The live markets run on a **fresh numéraire-correct mock pair**, ordered so that
`dWETH < dUSDC` by address ⇒ `token0 = dWETH`, `token1 = dUSDC = numéraire`
(`arbitrum-sepolia.json:66`).

| Item | Value | Source |
| --- | --- | --- |
| **dWETH** (demo volatile token, token0) | `0xA8C07E1B245B346c5D1910c5055Efe67bF9E7D1D`, 18 dec | `arbitrum-sepolia.json:67`–`68` |
| **dUSDC** (demo numéraire, token1) | `0xB89630Dc6e020ae2A84aE72b7d9EEDBDfb2C544d`, 6 dec | `arbitrum-sepolia.json:69`–`70` |
| **Pool** (dWETH/dUSDC, fee 500) | `0xfE1Eb4D5796a350B13852F822B3E6a9fDbb858a5` | `arbitrum-sepolia.json:71`–`72` |
| Seeded unprotected LP position (for previews) | tokenId `3218`, ~$100k | `arbitrum-sepolia.json:73`, `:66` |
| Demo market id (fee 500, 7d) | `0x67c4bee1ee037851fbe2a8ecfdd0b8ae3d358283e940750c268621f776479d69` | `arbitrum-sepolia.json:74` |
| smokeTestSwapId | `1` (the Path-A lifecycle swap) | `arbitrum-sepolia.json:75` |

dWETH is oracle-priced via the **real Chainlink ETH/USD feed** so the demo moves
with live ETH. The seed flow is `Factory.createPool → pool.initialize(sqrtP) →
NPM.mint`; ~$100k unprotected LP + funded tranches were seeded by
`script/SeedDemo.s.sol` (`arbitrum-sepolia.json:35`, `:41`, `:66`).

### 1.2 The live create→settle lifecycle (2026-06-05)

A **live, no-time-warp** create→settle ran on a short 300s fee-500 market
`0xb8bbd684f213d5833886ade7b531a6949d85522249881a2b5d46a5cc76e439c2`, settled at
the Chainlink round bracketing each expiry. All amounts USD (dUSDC, 6 dec). The
fresh demo MM (`0xe632B215120dD43A719458487bA3e03638fec953`) deposited 5,000
dUSDC into UnderwriterVault and its OWN collateral paid the Path-B settlement
(`arbitrum-sepolia.json:77`–`80`).

**Path A (cvAMM pool) — swapId 1, LP tokenId 3220** (`arbitrum-sepolia.json:81`–`91`):

| Field | Value | Meaning |
| --- | --- | --- |
| V0 | 270,531.28 | position value (numéraire) at entry |
| MaxIL | 1,669.24 | collateral locked = the cap |
| premium | 9.70 | what the LP paid |
| premium % of MaxIL | 0.58% | the convexity premium is a tiny fraction of MaxIL |
| settled realized IL | 148.64 | actual IL at expiry |
| settled payout | 148.64 | paid to LP, from the ConvexityVault (below the cap, so no truncation) |

**Path B (routed to MM) — swapId 2, LP tokenId 3221** (`arbitrum-sepolia.json:92`–`105`):

| Field | Value | Meaning |
| --- | --- | --- |
| premium A (cvAMM) | 13.80 | the pool's price |
| premium B (MM) | 8.93 | the MM's price |
| chosen path | **B (MM)** | `createSwapRouted` picked the MM because it STRICTLY beat the pool |
| MM loadBps | 1000 (10%) | MM's load over FairPremium |
| MaxIL | 3,215.65 | MM collateral locked |
| settled realized IL | 245.66 | |
| settled payout | 245.66 | paid from the **MM's OWN** UnderwriterVault collateral |

This is the on-chain proof of the two pillars: Path A is always-on and
signature-free; Path B wins the route only when it genuinely undercuts the capped
pool price, and the MM's own collateral settles it.

### 1.3 Subgraph status (pending)

The subgraph deploy is **pending**. The SDK degrades gracefully: history/precise
fill attribution return a typed pending state (`'rich-events-absent'` /
`'no-history-source'`) rather than throwing (`packages/sdk/src/types.ts:23`–`33`).
Three additions are coded on `main` but await a **single redeploy** — the
`QuoteFilled` and `SwapPriced` events and `CvammPricing.loadComponents()` —
and the **on-chain moat dataset begins at that redeploy** (`spec.md:987`–`993`).
The known blocker: after adding the events, `InflexionCore` is +213 B over the
EIP-170 limit (24,789 vs 24,576 B), so a size pass precedes the redeploy
(`spec.md:995`).

---

## 2. The 9 markets (3 fee tiers × 3 durations)

The deploy registers **9 markets = 3 fee tiers × 3 durations** for the dWETH/dUSDC
pair (`spec.md:690`; `apps/web/lib/markets.ts:1`).

- **Fee tiers (uint24):** `500` (0.05%), `3000` (0.30%), `10000` (1.00%) — `apps/web/lib/markets.ts:18`.
- **Durations:** `7d` (604,800 s), `30d` (2,592,000 s), `90d` (7,776,000 s) — `apps/web/lib/markets.ts:19`.

### 2.1 marketId derivation (the canonical formula)

```
marketId = keccak256(abi.encodePacked(token0, token1, fee, durationSeconds))
```

with `token0 = dWETH`, `token1 = dUSDC` (token0 < token1 by address). Types are
`(address, address, uint24, uint32)`. This is identical on-chain and in the SDK:

- On-chain `registerMarket`: `keccak256(abi.encodePacked(cfg.token0, cfg.token1, cfg.fee, cfg.durationSeconds))` — `InflexionCore.sol:355`.
- On-chain cross-check at create (must equal the supplied marketId): `InflexionCore.sol:590`–`591`.
- SDK / frontend mirror: `apps/web/lib/markets.ts:21`–`28` (`encodePacked(['address','address','uint24','uint32'], [demoWeth, demoUsdc, fee, durationSeconds])`).

**Why this shape.** The duration is baked into the id, so the SAME position
geometry yields a different marketId (and a different price) per duration — the
cvAMM publishes 3 prices for the same MaxIL (the S-curve in σ²·T does the work;
`spec.md:191`, `:243`–`247`).

### 2.2 The grid (anchors)

| | 7d | 30d | 90d |
| --- | --- | --- | --- |
| **fee 500 (0.05%)** | `MARKETS[0]` = demo `0x67c4…9d69` (`arbitrum-sepolia.json:74`) | `MARKETS[1]` | `MARKETS[2]` |
| **fee 3000 (0.30%)** | `MARKETS[3]` | `MARKETS[4]` | `MARKETS[5]` |
| **fee 10000 (1.00%)** | `MARKETS[6]` | `MARKETS[7]` | `MARKETS[8]` |

`MARKETS` is `FEES.flatMap(fee → DURATIONS.map(...))`, so it iterates fee-outer,
duration-inner (`apps/web/lib/markets.ts:30`–`43`). `DEMO_MARKET_ID =
demo.marketId_fee500_7d` sanity-matches `MARKETS[0]` (`apps/web/lib/markets.ts:46`).
The short 300s lifecycle market (`0xb8bbd684…`) is a *separate, extra* market used
only for the live create→settle demo — it is NOT one of the 9
(`packages/sdk/src/addresses.ts:102`).

---

## 3. Decimals & units (the numéraire conventions)

| Quantity | Scale | Notes |
| --- | --- | --- |
| **dUSDC** (numéraire) | **6 decimals** | All premiums, MaxIL, V0, payouts are 6-dec raw integers (`arbitrum-sepolia.json:70`; `packages/sdk/src/types.ts:13`). |
| **dWETH / WETH** (volatile token0) | **18 decimals** | `arbitrum-sepolia.json:68`. |
| **Chainlink price feeds** | **8 decimals** | All 4 USD feeds (`arbitrum-sepolia.json:20`; `packages/sdk/src/addresses.ts:58`). |
| **WAD** | **1e18** | Fixed-point unit; 1e18 = 1.0. Used for σ_ref, fairRate, load components, `a`/`b` ratios (`packages/sdk/src/math.ts:19`). |
| **BPS_TO_WAD** | **1e14** | 1 basis point in WAD (`packages/sdk/src/math.ts:20`). |
| **sqrtPriceX96** | Uniswap **Q64.96** | sqrt price (`packages/sdk/src/types.ts:15`). |
| **ILMath internal** | **Q64.96** | Pure fixed-point IL math (`packages/sdk/src/addresses.ts:28`). |
| **FairValueOracle internal** | **1e24** | Lifts WAD→1e24 for precision, rounds back to WAD half-up (`fairrate.rs:27`–`30`, `:159`). |
| **SECONDS_PER_YEAR** | **31,536,000** | 365-day year, matches the Python model (`VolOracle.sol:37`; `fairrate.rs:31`). |

**Convention:** `*Wad` fields are 1e18-scaled; USDC amounts are 6-dec raw bigints;
prices are feed-decimal raw integers unless the field name says `Wad`
(`packages/sdk/src/types.ts:13`–`15`).

---

## 4. Environment variables

### 4.1 Repo-root `.env` (contracts / deploy / shared) — `.env.example`

| Var | Default / example | Purpose |
| --- | --- | --- |
| `ARBITRUM_RPC` | `https://arb1.arbitrum.io/rpc` | Arbitrum One RPC |
| `SEPOLIA_RPC` | `https://sepolia-rollup.arbitrum.io/rpc` | Arbitrum Sepolia RPC |
| `LOCAL_RPC` | `http://localhost:8545` | local Nitro fork |
| `DEPLOYER_PRIVATE_KEY` | — | Sepolia + local only; never mainnet |
| `OPERATOR_PRIVATE_KEY` | — | demo-mode oracle operator; never mainnet |
| `ETHERSCAN_API_KEY` / `ARBISCAN_API_KEY` | — | verification |
| `THEGRAPH_DEPLOY_KEY` | — | subgraph deploy |
| `ENGINE_PORT` | `8787` | Path-B relayer port |
| `REDIS_URL` | `redis://localhost:6379` | engine |
| `VITE_API_URL` / `VITE_SUBGRAPH_URL` / `VITE_NETWORK` | (`sepolia`) | legacy frontend keys |

Source: `.env.example:1`–`25`; also documented in `RUNBOOK.md:83`–`86`.

### 4.2 Frontend (`apps/web`) — `apps/web/.env.example`

All `NEXT_PUBLIC_*` (build-time public):

| Var | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_RPC_URL` | (falls back to public RPC) | Arbitrum Sepolia RPC the dApp reads from. Set your own Alchemy/Infura for a smooth demo. |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | — | WalletConnect Cloud id (RainbowKit). Injected wallets work without it. |
| `NEXT_PUBLIC_ENGINE_URL` | `http://localhost:8787` | Path-B engine base URL. Unset ⇒ Path-B quotes unavailable, premium falls back to Path A (app still works end-to-end). |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8088` | Public REST API base URL (optional; the dApp reads live data via the SDK directly). |

Source: `apps/web/.env.example:1`–`19`.

### 4.3 Engine (`packages/engine`) — read from `process.env`

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | relayer listen port |
| `CHAIN_ID` | `421614` | Arbitrum Sepolia |
| `VERIFYING_CONTRACT` | registry `core.inflexionCore` | EIP-712 verifying contract (InflexionCore) |
| `QUOTE_LOG` | (optional) | append-only JSONL of accepted quotes |
| `DEMAND_LOG` | (optional) | Signal-4 latent demand telemetry (unfilled/previewed interest) |
| `COMPETITION_LOG` | (optional) | Signal-2 quote-competition telemetry (winners + losers) |

`DEMAND_LOG` / `COMPETITION_LOG` are **day-one sinks** — those signals are
unreconstructable retroactively, so set them from the first deploy
(`packages/engine/src/index.ts:1`–`27`). The MM bot reads `MM_PRIVATE_KEY`,
`MARKET_ID`, `ENGINE_WS`, `CHAIN_ID`, `VERIFYING_CONTRACT`, `QUOTE_PRICE`,
`LOAD_BPS` (`packages/engine/src/mm-bot.ts:24`–`34`).

### 4.4 API (`packages/api`) — read from `process.env`

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8088` | REST listen port |
| `SUBGRAPH_URL` | (absent ⇒ surfaces "pending") | deployed subgraph GraphQL endpoint |
| `ARBITRUM_SEPOLIA_RPC` / `SEPOLIA_RPC` | — | RPC for live reads |
| `DEMAND_LOG` / `COMPETITION_LOG` | (optional) | telemetry log paths surfaced via the API |

Source: `packages/api/src/server.ts:6`–`25`.

---

## 5. Repo layout

From `CLAUDE.md` + `spec.md:998`–`1008`:

```
packages/contracts/   Foundry — Solidity + Stylus; test/ (unit, fork, Invariants.t.sol); script/Deploy.s.sol
  stylus/ILMath/      Rust Stylus IL math (REJECTED benchmark artifact — NOT deployed; revm CI cross-check only)
  stylus/FairValueOracle/  Rust Stylus PRODUCTION fairRate Φ-sum pricer (DEPLOYED)
packages/engine/      Off-chain Path-B matching relayer (Node/TS): WS quote intake, ranking, signed-payload API
packages/sdk/         @inflexion/sdk — LP / MM-quoter / cvAMM-depositor / data surfaces
packages/subgraph/    The Graph subgraph (schema + mappings) — deploy PENDING
packages/api/         Public REST API (Railway/Fly) over the subgraph
apps/web/             React + Vite, wagmi/viem, RainbowKit, Apollo, shadcn/ui, Recharts
apps/docs/            docs.inflexion.xyz (Mintlify)
quant/                Python → cvAMM params schema (params.cvamm.schema.json); gates PARTIAL; legacy/ = multi-asset
docs/                 Root-level: MATH, SECURITY, INTEGRATION, API
scripts/              Cross-platform helpers (.sh + .ps1)
deployments/          Per-network address registries (arbitrum-sepolia.json, etc.)
```

**Conventions** (`CLAUDE.md`): Solidity 0.8.24, `via_ir = true`, optimizer 1M runs
(`optimizer_runs=1500` was used for the size-constrained deploy —
`arbitrum-sepolia.json:41`); TypeScript strict ES2022 NodeNext; Rust edition 2021,
rustc 1.88 pinned (`RUNBOOK.md:50`); Python 3.12+, `uv` + ruff. Stylus builds are
**WSL2/Linux only** (`RUNBOOK.md:14`, `:30`–`42`).

---

## 6. Glossary (exhaustive, with the WHY)

### Product framing

- **Inflexion** — a collateralized bilateral **derivatives market** on Arbitrum
  One (live on Arbitrum Sepolia for the hackathon) that lets Uniswap v3 LPs pay a
  fixed upfront premium to transfer the **in-range** impermanent-loss risk of a
  *specific* position to an underwriter, who posts collateral and is paid for
  taking the risk. At expiry the protocol pays the LP their realized IL, **capped
  at MaxIL**, trustlessly, from the underwriter's collateral (`CLAUDE.md`;
  `spec.md:12`).
- **In-range convexity hedge (NOT "IL insurance")** — entry requires `Pa ≤ P0 ≤
  Pb` (out-of-range rejected at creation), payout = `min(realized_IL, MaxIL)`, and
  the cap is load-bearing for the no-bad-debt guarantee. Mislabeling it "IL
  insurance" is both a demand risk (sophisticated LPs discount the truncated tail)
  and a reputational/regulatory one (`spec.md:180`). Every LP surface must show
  the payoff diagram (covered up to MaxIL; uncovered beyond range) — the cap must
  never surprise an LP (F-#5, `spec.md:180`).
- **FULL mode** — fully collateralized: collateral = MaxIL. The launch mode; the
  one with the no-bad-debt guarantee. **PARTIAL** is roadmap (leverage dial; every
  PARTIAL parameter must come from `quant/params.json`, never hardcoded;
  `CLAUDE.md`; `spec.md:724`).
- **European / FULL lifecycle** — settlement only at expiry (`spec.md:432`).

### The two values & the IL math

- **P** — price of token0 in token1 (e.g. ETH in USDC). **P0** = entry price (the
  oracle price at `createSwap`, NOT the LP's original mint). **P_T** = settlement
  price (`spec.md:136`, `:158`).
- **Pa, Pb** — the position's lower/upper range bounds (price). Enforced `Pa ≤ P0
  ≤ Pb` at creation; out-of-range reverts `PositionOutOfRange`
  (`ILMath/src/lib.rs:22`–`24`).
- **L (liquidity)** — Uniswap v3 liquidity of the position. **Read once at
  creation and STORED** in the `SwapRecord`; settlement uses the stored L, never
  re-read from the NFT (invariant I6 — external `increaseLiquidity` cannot inflate
  payout; `spec.md:158`, `:1017`).
- **V_hold(T)** — value if the LP had just held the entry tokens =
  `amount0_entry · P_T + amount1_entry` (affine in P_T) (`spec.md:144`).
- **V_lp(T)** — value of the LP position at P_T (three regimes: in-range, below
  Pa = all token0, above Pb = all token1) (`spec.md:147`–`153`). Strictly concave
  in range, which is what makes IL convex.
- **realized_IL** — `max(0, V_hold(T) − V_lp(T))`. Always computed as
  `V_hold > V_lp ? V_hold − V_lp : 0`, never an unchecked subtraction (I3;
  `spec.md:155`, `:1014`). The swap covers IL accruing **from creation onward** —
  any IL borne before covering stays the LP's (entry-snapshot semantics, F-#10,
  `spec.md:158`).
- **V0** — position value in the numéraire (token1) at entry. The capacity unit
  for `maxNotionalV0` (Path B capacity is denominated in V0, not collateral, F-#6;
  `spec.md:361`). Dust floor `MIN_POSITION_V0` rejects tiny positions
  (`InflexionCore.sol:988`).

### MaxIL — the cap AND the unit of risk

- **MaxIL** = `max(IL(Pa), IL(Pb))` — the maximum in-range IL of the specific
  position (`spec.md:169`; `ILMath/src/lib.rs:39`). It is **pure geometry**
  (computable from `Pa, Pb, L, P0`), **frozen at creation**, **identical across
  the 3 durations**, and **L-independent in the fair-rate sense**. This is what
  makes positions **fungible to an underwriter within a market** (`spec.md:97`,
  `:191`).
- **Two roles, both load-bearing:** (a) the **load-bearing cap** —
  `covered_payoff = min(realized_IL, MaxIL)`, and `collateral_FULL = MaxIL ≥
  payout` by construction, so FULL cannot produce bad debt on any price path
  (structural, oracle-independent — `spec.md:176`–`178`); (b) the **collateral /
  normalization unit** — pricing as `% of MaxIL` makes the underwriter's ROC
  range-width-independent ⇒ no adverse selection against wide ranges ⇒ full depth
  (the key pricing innovation, `spec.md:224`).
- **MaxIL is a normalization unit, NOT a risk metric** — two positions with
  identical MaxIL can carry very different risk (distance-to-edge, delta). Both the
  pool and MMs price the *specific geometry*, so MaxIL alone never sets the price
  (`spec.md:253`).
- **Why the cap is correct, not a defect:** beyond the range the LP is fully
  rotated into one asset; loss past that point is *directional* (foregone spot
  upside), not the *impermanent* loss being hedged. Capping keeps the product
  fully collateralized and trustless (`spec.md:180`).
- **Reference magnitudes** (geometric-symmetric range, from `il.py`):
  ±5% → MaxIL ≈ 1.27% of V0; ±10% → 2.56%; ±20% → 5.23%; ±50% → 13.76%
  (`spec.md:185`–`188`).
- **An MM quote is PER-MARKET, never per-NFT** — because MaxIL makes positions
  fungible within a market, an MM quotes a load + a MaxIL-ratio band + capacity for
  a whole market, not a single NFT (`spec.md:265`, `:326`–`327`).

### Pricing — FairValue, fairRate, FairPremium, σ_ref

- **fairRate** = `E_Q[min(IL, MaxIL)] / MaxIL` — the fraction of MaxIL the claim
  is worth under the risk-neutral measure. An **S-curve in σ²·T** (≈0 calm/short,
  →1 violent/long). Carries **all** the vol/time dependence; MaxIL carries none.
  It has an **exact closed form** (no fitted coefficients): the v3 payoff is
  piecewise (constant / linear-in-P / √P arms split by the two cap-crossing
  prices), each arm integrated against the GBM density of P_T is a normal-CDF
  interval moment, so `FairPremium = E_Q[min(IL,MaxIL)]` is a finite **Φ-sum**
  (≈6–10 terms). **L-independent** — depends only on `a = Pa/P0`, `b = Pb/P0`,
  `σ_ref`, `T`. `σ_ref` is the only stochastic input. (`spec.md:98`, `:106`,
  `:204`; `fairrate.rs:1`–`12`.)
- **FairPremium** = `fairRate · MaxIL` — the fair value of the claim, **published
  on-chain** by the Stylus `FairValueOracle.fairPremium(token, a, b, duration,
  maxIL)` which reads σ_ref via STATICCALL to the VolOracle
  (`FairValueOracle/src/lib.rs:143`–`158`; `spec.md:94`).
- **The Φ-sum is NEVER reimplemented off-chain** (CLAUDE.md hard rule). The SDK
  reads the on-chain FairPremium and never approximates it. The only off-chain
  duplication permitted is the *load* math, not the fairRate (`packages/sdk/src/math.ts:1`–`7`).
- **σ_ref (reference volatility)** = `max(σ_short, σ_long, floor)` — a poke-based,
  **time-aware EWMA of Chainlink-tick log-returns** over two horizons + a hard
  floor (`VolOracle.sol:643` analog; `:189`–`197`). Annualised over a 365-day year
  (`VolOracle.sol:37`).
  - **Why max(...) and never raw realized σ:** realized vol *understates* risk
    right before a regime change — a stale-σ jump is exactly where the book bleeds.
    The conservative max cannot fall below the slower estimate or the floor, so it
    never collapses to a deceptively calm number just before a jump. This caveat is
    **mandatory** (`spec.md:647`).
  - **Why poke-based:** Chainlink rounds are irregular and reading deep history per
    quote is gas-prohibitive; a permissionless `poke` keeps an O(1) EWMA. `dt` is
    clamped to `[minSampleInterval, maxSampleInterval]`. `poke` is a **no-op that
    emits no event when `dt < minSampleInterval`** (`VolOracle.sol:27`, `:102`–`107`).
  - **`sigmaComponents.binding`** — which input binds σ_ref: 0=short EWMA, 1=long
    EWMA, 2=floor. Distinct from the load *regime* (`VolOracle.sol:138`–`155`;
    `packages/sdk/src/types.ts:97`–`104`). At the fresh deploy σ_ref sits at the
    0.5e18 floor (fairRate ≈ 0.847 at floor vol; `arbitrum-sepolia.json:41`).
  - **Scope:** σ_ref (and FairValueOracle) is solvency-load-bearing for the **I10
    cap and depositor solvency** (a wrong σ mis-prices the load and compresses NAV),
    but **NOT** for the FULL no-bad-debt invariant I1, which is structural and
    oracle-independent (`spec.md:650`).

### Load stack (the cvAMM premium over fair value)

```
premium = FairPremium · (1 + baseLoad + util_skew + dispersion_skew)
        , HARD-CAPPED at FairPremium · (1 + maxLoad)        // invariant I10
```

- **load / totalLoad** — the multiplier over FairPremium. `totalLoadWad =
  min(baseLoad + util_skew + dispersion_skew, maxLoad)` (I10 clamp;
  `packages/sdk/src/math.ts:118`–`126`).
- **baseLoad** — the structural volatility-risk premium over fair value, banded by
  σ_ref regime (calm/normal/stressed). Motivated by the **lone-writer CVaR gap**:
  a single position's CVaR95 sits at ~91–100% of MaxIL, so an uncharged writer is
  badly underpriced; diversification collapses the gap (~100%→78.7% as N:1→100).
  The pool charges baseLoad; that gap is its reason to exist (`spec.md:217`;
  `packages/sdk/src/math.ts:70`–`78`).
- **util_skew** (`locked / (locked + free)`) — rises as the pool nears full
  commitment. Flat below a knee, convex above, capped. Wires into the
  withdrawal-delay / locked-free run defense (`spec.md:273`;
  `packages/sdk/src/math.ts:81`–`87`).
- **dispersion_skew** — rises as outstanding coverage **clusters** in one
  width/moneyness/duration corner (the honest single-pair analogue of
  concentration; many bunched positions all hit MaxIL together in one move). A
  well-dispersed book is charged less (`spec.md:274`;
  `packages/sdk/src/math.ts:90`–`94`).
- **Regime (calm / normal / stressed)** — the *load* regime from σ_ref vs the
  loadParams bands. **Distinct from `sigmaComponents.binding`** (`packages/sdk/src/math.ts:143`–`147`).
- **maxLoad / maxLoadBps** — the I10 ceiling: same value as a rate (`maxLoad`) or
  in basis points (`maxLoadBps`) on-chain (`spec.md:228`).
- **All load/skew/σ primitives come from `params.json` (cvAMM block); none is
  hardcoded** (the exact failure the audit flagged). fairRate itself has NO
  calibrated coefficients (`spec.md:222`, `:696`; `CLAUDE.md`).
- **Path-B premium** = `ceil(FairPremium · (1 + loadBps/1e4))`, capped at MaxIL,
  requires `loadBps ≤ maxLoadBps` (I10 on Path B). Premiums round **UP** (F-#8;
  `packages/sdk/src/math.ts:133`–`137`; `spec.md:226`).

### The three pillars

1. **On-chain published FairValue (Pillar 1)** — the exact closed-form Φ-sum,
   never reimplemented off-chain; the Stylus FairValueOracle is production
   (`spec.md:89`).
2. **The cvAMM pool (Pillar 2, Path A)** — `ConvexityVault`, a dual-tranche
   ERC-4626 pooled passive underwriter that quotes algorithmically on-chain off
   FairPremium with inventory skews, always-on, signature-free, I10-capped. The
   **floor of liquidity** (`spec.md:108`).
3. **MM competition (Pillar 3, Path B)** — sophisticated MMs compete via firm
   EIP-712 signed quotes **below** the pool, no last-look. The **ceiling of
   price**. Two load-bearing reasons: hedged MMs export short-gamma risk *out of*
   the system (a closed pool just circulates ETH short-gamma against itself);
   forward-vol MMs correct the pool's backward-looking σ_ref bias (`spec.md:119`–`126`).

### Paths & routing

- **Path A (cvAMM, default, signature-free)** — `createSwapPathA`: reads
  FairPremium + pool inventory, applies the I10 load stack, locks ConvexityVault
  collateral, splits the premium across tranches. No keeper, no signed quote, no
  validity clock, no relayer (`spec.md:288`; `InflexionCore.sol:929`).
- **Path B (MM signed quotes)** — `createSwap`: an MM posts collateral + signs a
  quote below the pool; the LP can take it. Carries the full signed-quote rail
  (`validUntil`, `priceBandBps`, bitmap nonces, the Fork-2 band defense, I9). The
  premium is **derived on-chain** from FairPremium as `FairPremium·(1+loadBps)`;
  on Path B the premium goes entirely to the MM (no tranche split) (`spec.md:290`).
- **createSwapRouted** — routes the LP to the **cheaper of {pool, valid MM
  quote}**, both priced off the SAME on-chain FairPremium (single VolOracle poke).
  MM wins only if it **strictly** beats the pool; a tie resolves to Path A. An
  absent/expired/stale/over-band/over-load/zero-price MM quote **falls back to the
  pool — never reverts**. **Only the executed rail mutates nonce/capacity/lock**
  (so I7 holds) (`spec.md:292`; `InflexionCore.sol:973`–`1014`).

### Vaults & tranches

- **ConvexityVault** — the Path-A pooled underwriter. One vault per pair backing
  all 9 markets with **fungible** USDC; quotes a separate price into each market
  (one insurer's treasury backing 9 product lines). Dual-tranche from launch
  (`spec.md:690`).
- **UnderwriterVault** — per-MM Path-B collateral (`deposited` / `locked` /
  `available = deposited − locked`). `lockCollateral` at match, never in the quote
  payload; `releaseAndDistribute` at settle (`spec.md:660`–`673`).
- **Senior tranche** — base yield + a small premium slice
  (`seniorPremiumShareBps`), **structurally protected from *underwriting* loss**
  while junior buffers. A "convexity savings account." `Tranche` enum value 0
  (`packages/sdk/src/types.ts:183`).
- **Junior tranche** — captures most of the load, high APY, **first-loss and
  unhedged** — bears the entire underwriting tail. A "pure vol-selling tranche."
  `Tranche` enum value 1 (`packages/sdk/src/types.ts:183`).
- **Structural senior protection** = `totalLocked ≤ juniorAssets`, enforced at
  **every** `lockCollateral`. Since every payout ≤ its MaxIL = its locked amount,
  `Σ payouts ≤ totalLocked ≤ juniorAssets`, so junior absorbs all underwriting
  loss before senior is touched (`spec.md:691`).
- **`sf = 0.60` (P1.13)** — the TARGET tranche ratio for UX/incentives, NOT a hard
  cap. Senior P(loss)=0 is the **calibration** result (holds while `u ≤ 1−sf`),
  not a structural guarantee (`spec.md:691`).
- **CAPITAL IS NOT GUARANTEED** — depositor capital (both tranches) is NOT
  guaranteed: junior is first-loss; senior is protected from *underwriting* loss
  while junior buffers but takes the **systemic tail** (USDC depeg, oracle/settle
  fault, contract bug). This is a volatility-selling product. Mandatory disclosure
  at every depositor entry point (`spec.md:707`–`718`;
  `packages/sdk/src/types.ts:205`, `:223`).
- **Two guarantees, NEVER merged:** (A) LPs are always paid (no bad debt in FULL —
  structural, code-enforced I1); (B) depositors can lose principal. Both true;
  neither implies the other (`spec.md:650`, `:713`).
- **Real P1.13 single-asset numbers** (bare pool, u=0.40): 3y CAGR 122% median /
  50% p10 / 247% p90; P(losing month) 26.5%; 1-in-100 month −20.1%; worst month
  −26.8%. Senior (sf=0.60): P(loss)=0 / worst 0%; junior worst −67%
  (`spec.md:718`).
- **Idle-only yield (hard rule):** locked collateral must stay instantly liquid —
  never routed to utilization-gated venues (Aave/Compound), only idle/free capital
  to instantly-redeemable wrappers (sDAI / tokenized T-bills), with a hard cap and
  a nude-USDC buffer (F-#3; `spec.md:680`; `CLAUDE.md`).

### Signed quote (Path B EIP-712)

- **SignedQuote** struct fields (`InflexionCore.sol:122`–`136`): `mm`, `marketId`,
  `loadBps`, `minMaxILRatioBps` / `maxMaxILRatioBps` (optional convenience filter),
  `quotePrice` (oracle price at signing — the band anchor), `priceBandBps`,
  `model` (CollateralModel; FULL=launch), `partialRatioBps` (0 in FULL),
  `maxNotionalV0` (capacity in V0), `validUntil`, `quoteId` (capacity/replay key),
  `nonce` (Permit2-style bitmap).
- **SIGNED_QUOTE_TYPEHASH** is the keccak of the full type string with `loadBps`
  in struct order (`InflexionCore.sol:141`–`142`). Verification is OZ
  `SignatureChecker.isValidSignatureNow` to support EIP-1271 contract signers
  (e.g. the vault as signer; `spec.md:340`, `:427`).
- **validUntil** — default `now + 8s`, protocol-enforced band **[5s, 15s]**. A
  *latency* control (not risk-capital), bounding how long a bearer signed quote
  survives in observer hands (`spec.md:344`–`355`).
- **priceBandBps + quotePrice (Fork-2 band)** — the quote auto-voids on-chain if
  the live oracle drifts beyond `priceBandBps` from `quotePrice`. Firm quotes, NO
  last-look — all protection is deterministic on-chain (`spec.md:342`, `:363`).
- **Bitmap nonce (Permit2-style, `word<<8 | bit`)** — selective cancel of ONE
  quote, never cancel-all; batchable (F-#7; `spec.md:359`).
- **quoteId / consumedNotional** — `createSwap` requires `consumedNotional[quoteId]
  + V0 ≤ maxNotionalV0`, then increments atomically (replay/double-spend defense,
  F-#6; on-chain authoritative, off-chain engine advisory; `spec.md:360`).

### Settlement / SwapRecord

- **Status enum:** 0 = `UNINITIALIZED`, 1 = `ACTIVE`, 2 = `SETTLED`
  (`InflexionCore.sol:112`–`116`; `packages/sdk/src/types.ts:241`).
- **settle** — callable by anyone at `block.timestamp ≥ expiry`. Strict CEI:
  status flips to SETTLED first, then interactions (`spec.md:539`;
  `InflexionCore.sol:1074`–`1079`).
- **OracleManager settle path (`getSettlementPrice`)** — price pinned to the
  Chainlink round active *at expiry T* (kills settle-timing games), gated by
  sequencer health + staleness + a **lone-spike** sanity check; Uniswap TWAP is
  **advisory-only** (emitted, never reverts) (`spec.md:564`–`601`).
- **Settlement constants:** `GRACE_PERIOD` 3600s; `MAX_STALENESS` 90,000s;
  `LONE_SPIKE_BPS` 500 (5%); `LIVENESS_WINDOW` 86,400s (24h); `TWAP_WINDOW` 1800s;
  `MAX_DEVIATION_BPS` 200 (2%, advisory) (`spec.md:613`–`620`).

### The 10 invariants (NEVER break)

From `CLAUDE.md` §13 / `spec.md:1012`–`1021`:

| # | Name | Statement |
| --- | --- | --- |
| **I1** | No bad debt (FULL) | `payout ≤ collateral == MaxIL`. Qualified clause: capped payoff + locked collateral + solvent USDC + oracle/settlement liveness + no rehypothecation breach. |
| **I2** | Cap correctness | `payout == min(realized_IL, MaxIL)`. |
| **I3** | Non-negativity / no underflow | `realized_IL = V_hold > V_lp ? V_hold − V_lp : 0` — never an unchecked subtraction. |
| **I4** | LP never profits | `V_lp ≥ V_hold ⟹ payout == 0`. A hedge, not a lottery. |
| **I5** | Vault solvency | `locked ≤ deposited` per MM (and for the pool); `Σ locked` fully backed. |
| **I6** | Liquidity immutability | settlement uses `L` stored at creation, never re-read; `increaseLiquidity` cannot inflate payout. |
| **I7** | Capacity authority | `consumedNotional[quoteId] ≤ maxNotionalV0`; a cancelled bitmap-nonce bit cannot fill. |
| **I8** | Settlement liveness (Fork 1) | `settle()` always succeeds within `expiry + LIVENESS_WINDOW + MAX_STALENESS + GRACE_PERIOD`. |
| **I9** | Band enforcement (Fork 2) | `createSwap` reverts iff `absBps(P_live, quote.quotePrice) > quote.priceBandBps` (Path B only). |
| **I10** | Price cap (launch) | `premium ≤ FairPremium · (1 + maxLoadBps)` on BOTH paths — by construction, upstream of settle. Does NOT touch settle/MaxIL/I1–I9. |

### The two forks (audit-resolved deadlock/pickoff classes)

- **Fork 1 — oracle settlement deadlock** (resolved, Option B): the v3.1 hard-TWAP
  gate could permanently lock funds; replaced by Chainlink round-at-T pinning +
  lone-spike check + advisory-only TWAP + a 24h liveness backstop ⇒ settle can
  never deadlock (I8) (`spec.md:601`–`603`).
- **Fork 2 — no-last-look quote pickoff** (resolved, Option B, Path B only): a
  bearer signed quote could be picked off after an oracle gap; resolved by the
  **oracle-anchored price band** (auto-void if drift > `priceBandBps`) + short
  `validUntil` + on-chain selective nonce invalidation. All deterministic — NOT
  last-look (I9) (`spec.md:342`, `:363`).

### The data moat (5 behavioral signals)

The first public view into the **microstructure of the DeFi LP volatility-risk
premium** — non-circular, actor-driven (`spec.md:894`–`908`):

1. **Realized clearing LOAD over a transparent σ_ref** — bucketed by `width ×
   distance-to-edge × duration` (exclude cap-bound fills). Pool load = mechanical
   baseline (`SwapPriced.totalLoadWad`); MM load (`QuoteFilled.loadBps`) = the
   behavioral signal. The circular "invert fairRate for an implied-vol surface"
   claim is **DROPPED** (charged/MaxIL = fairRate(σ_ref)·(1+load) only recovers our
   own σ_ref + dealer load).
2. **Pool-vs-MM load spread + MM win-rate** — a forward-vol read (MM prices
   implied/forward vol; pool prices backward σ_ref). Dynamic with ≥3 MMs.
3. **Term structure of convexity** — MM `loadBps` slope across 7/30/90d per range
   (the Path-A load is duration-independent/mechanical, so the slope is the MM
   signal).
4. **Moneyness / demand skew** — realized on-chain PLUS the latent/unfilled half
   via off-chain engine telemetry (`DEMAND_LOG`).
5. **Net convexity / gamma supply** — off-chain Greeks summed over the active set
   (GreeksEngine over the subgraph).

**Honest framing (mandatory):** we sell the *architecture* of the moat —
structures exist day-one; the dynamic/latent halves mature with MM + flow volume;
the on-chain half (signals 1/2/3/5) begins at the single redeploy. The clearing
load is contaminated (liquidity + SC risk + capital-lock + inventory-skew premia)
— trade the SPREAD, not the level (`spec.md:908`, `:939`).

### Theory anchors (cite, do not re-derive)

- **Lipton, Lucic & Sepp (2025)** — an IL-protection claim is statically
  replicable by a strip of vanilla options ⇒ model-light fair value + concrete
  hedge (`spec.md:103`).
- **Milionis, Moallemi & Roughgarden (2022), LVR** — the AMM's adverse-selection
  cost has a closed form proportional to instantaneous variance (= the theta of
  the replicating short-option position) ⇒ a closed-form anchor for the cost of
  short-gamma exposure (`spec.md:104`).

These are **theory anchors for *why* the claim is priceable and hedgeable — NOT
the on-chain pricer** (the exact Φ-sum is) (`spec.md:106`).

### The qualified no-bad-debt clause (never state unqualified)

> No-bad-debt is exact ONLY under: **FULL collateralization + capped payoff +
> solvent USDC + oracle/settlement liveness + no rehypothecation breach.**

(`CLAUDE.md`; `spec.md:715`). A σ_ref/vol-oracle fault can cost *depositors* money
(bad pricing — junior first, then senior in the tail) but can **never** create LP
bad debt in FULL (I1 is structural and oracle-independent) (`spec.md:650`).

---

## 7. Uncertainty / pending flags

- **Subgraph not deployed** — history + precise MM fill attribution degrade to a
  typed pending state. `QuoteFilled` / `SwapPriced` / `CvammPricing.loadComponents`
  are coded on `main` but await a single redeploy; the on-chain moat dataset begins
  there (`spec.md:987`–`993`).
- **EIP-170 size blocker** — InflexionCore is +213 B over the limit after the
  events; a size pass precedes the redeploy (`spec.md:995`).
- **Sequencer uptime feed = `null`** on Sepolia — `OracleManager` skips the
  sequencer check on testnet; this MUST be set before any mainnet deploy
  (`arbitrum-sepolia.json:11`–`12`).
- **σ_ref at floor** — at the fresh deploy σ_ref sits at the 0.5e18 floor
  (fairRate ≈ 0.847); real dynamics accrue as the VolOracle is poked over time
  (`arbitrum-sepolia.json:41`).
- **The mainnet addresses in §1 are spec/migration references**, not the live
  testnet deployment — do not conflate them with the Sepolia registry.
- **Heartbeat note** — the testnet ETH/BTC feeds tick ~120s vs the mainnet
  86,400s; `MAX_STALENESS=90,000s` is deliberately chosen to work on both
  (`arbitrum-sepolia.json:13`–`19`).
