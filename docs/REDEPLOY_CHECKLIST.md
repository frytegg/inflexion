# Single-redeploy checklist (the running gap list)

> **Plan (decided 2026-06-04):** code contract changes now, do NOT redeploy per
> change. Accumulate everything here as the SDK → subgraph builds reveal gaps,
> then **redeploy the Solidity stack to Arbitrum Sepolia EXACTLY ONCE**, at the
> milestone **after the subgraph is built, before the frontend**. The frontend
> consumes the SDK/API (not the contracts), so it rarely reveals on-chain gaps —
> by that point ~all are known. Re-verify this whole list before pulling the trigger.

## Contract changes already coded (live on `main`, NOT yet deployed)

- **`QuoteFilled(swapId, mm, quoteId, nonce, loadBps)`** — emitted in `_executePathB`. MM fill attribution (signals 1/2/3). _(coded)_
- **`SwapPriced(swapId, path, fairPremium, baseLoadWad, utilSkewWad, dispSkewWad, totalLoadWad, sigmaRefWad, cappedAtMaxIL)`** — emitted on all three create paths (`_pricePathA*`/`_pricePathB` + `_emitPriced`). Clearing-load data moat (signals 1/2/3/5). _(coded)_
- **`CvammPricing.loadComponents()`** (public) — returns base/util/disp/total separately. Feeds `SwapPriced` AND exposes the two skews on-chain for the SDK depositor/MM surface (the component fns are otherwise `internal`). _(coded)_

The deployed Sepolia bytecode is unchanged until the redeploy; the live demo still runs the pre-event stack.

## ✅ Size: `InflexionCore` back under EIP-170 — RESOLVED (2026-06-05)

After the moat events, `InflexionCore` was **24,789 B vs the 24,576 B limit (+213 B)** — undeployable (revm doesn't enforce EIP-170, so `forge build`/`forge test`/CI stayed green and hid it). **Fixed by lowering `optimizer_runs` 2000 → 1500** (`foundry.toml`): core is now **23,934 B (+642 B margin)**, restoring the pre-events headroom.

Verified on this machine (no home PC needed): **168 forge tests green**; a clean same-code 2000-vs-1500 gas diff shows every hot path moves **< 0.1%** (settle +0.062%, createSwap +0.082%, PathA +0.079%, router pathB +0.072%) and the **overall suite gas is net −0.032%** — negligible vs the size win. `.gas-snapshot` refreshed at 1500 (it was stale — generated pre-events). **No contract logic, ABI, or event signature changed**, so the subgraph/SDK are unaffected.

_(Considered + rejected: option 2 — moving the `SwapPriced` emit into a `public` library — would have changed the event's declaration site + the subgraph ABI for no gas gain over the runs change; option 3 — further library extraction — unnecessary, the runs change alone restored margin.)_

## Off-chain surfaces required (engine + API, NOT events — gas + I7)

- **Signal 4 latent demand** (unfilled/previewed-but-not-bought): engine logs every `/quote` + SDK `previewPremium` call → API `GET /data/demand-requests`.
- **Signal 2 dynamic half** (quote competition / MM no-quote / widen-under-stress): same engine telemetry → API `GET /data/quote-competition`.
- **Signal 5 net-gamma**: off-chain Greeks sum over the subgraph active-swap set (API/GreeksEngine) → `NetGammaSnapshot`.

> **DAY-ONE CAPTURE (do not skip — unreconstructable retroactively):** Signals 2 & 4
> are now logged by the engine **from the first interaction**, before any `/data`
> endpoint exists. `packages/engine/src/telemetry.ts` (`TelemetrySink`) writes two
> append-only JSONL sinks: `DEMAND_LOG` (every `GET /quote` + `POST /telemetry/preview`)
> and `COMPETITION_LOG` (every WS quote, winners + losers). **Set both env vars on
> the engine NOW**, not at redeploy — anything not captured before the redeploy is
> lost forever. The API just _reads_ these logs at redeploy. Schemas + ops:
> `docs/ENGINE_TELEMETRY.md`. The SDK `previewPremium` POSTs the best-effort ping.

## Doc-correctness fixes — APPLIED during the SDK build (2026-06)

From the access-layer verification (`docs/ACCESS_LAYER_ARCHITECTURE.md`): CvammPricing component skews were `internal` (now fixed on-chain via `loadComponents`); `regime` = σ_ref banded vs `loadParams.regimeCalm/Stressed` (NOT `sigmaComponents.binding`); `resolveMarket(swapId)` helper (SwapRecord omits marketId); LP oracle degraded-mode typed errors; MM streamable signal = geometry-independent inputs + pool `totalLoadWad`-in-bps (the "load to beat"); SwapPriced `cappedAtMaxIL` lets the moat exclude cap-bound fills; `SigmaPoint` backfill from `SwapPriced.sigmaRefWad` (poke is a no-op with no `Poked` event when `dt<minSampleInterval`).

**Status — these are now corrected inline in `docs/ACCESS_LAYER_ARCHITECTURE.md`** (see its "Build reconciliation" block, corrections #1–#7). Per-component skews remain a TS-port interim until the on-chain `loadComponents` ships at this redeploy — at which point the SDK depositor/MM/data surfaces switch to the on-chain call with **no `LoadBreakdown` shape change**. The single remaining moving part for the SDK at redeploy is: (a) point `CvammPricing.loadComponents` reads on-chain, (b) wire the `QuoteFilled`/`SwapPriced` events for PRECISE MM fill attribution (today `isQuoteFilled` is `precision:'coarse'`).

## SDK telemetry wiring — LIVE (no redeploy dependency)

The SDK `LpClient.previewPremium` now fires the best-effort `POST ${engineBaseUrl}/telemetry/preview` ping (fire-and-forget; swallows every error — never blocks/fails the preview). Combined with the engine's `TelemetrySink` (`DEMAND_LOG`/`COMPETITION_LOG`), Signals 2 & 4's dynamic halves are captured **from the first interaction, before the API exists**. **Set `DEMAND_LOG` + `COMPETITION_LOG` on the engine NOW** (see `docs/ENGINE_TELEMETRY.md`) — anything not captured before the redeploy is lost forever (I7). This is independent of the contract redeploy.

## ✅ Subgraph completion — marketId fix VERIFIED + event-order fix (2026-06-05; `graph build` (WASM) + keccak cross-check DONE)

Bounded gap from the P4.c build (`docs/ACCESS_LAYER_ARCHITECTURE.md` §6 note #6) — **now fixed, see "Implemented" below**:
`handleSwapCreated` does **not** derive `marketId` (the `SwapCreated`/`SwapPriced`/
`QuoteFilled` events + `SwapRecord` all omit it), so `Swap.market` stays null, the
per-market `Market` lifetime counters (`totalSwaps`/`totalV0`/`totalPremium`/
`totalPayout`/`pathBFills`/`totalSettled`) stay zero-init, and `MarketStateSnapshot`
is written by no handler. Effect: per-market volume/share (MM-11), the `/markets`
counters, and the per-market `/data/load-surface` series are empty. The
geometry-bucketed signals (S1/S2/S3/S4 via `BucketAggregate`/`GeometryDemandBucket`)
and protocol-wide S5 are **unaffected**.

**Implemented (2026-06-05) — `graph codegen` + `graph build` (WASM) + the keccak cross-check all pass (see "✅ Verified" below):**

1. `handleSwapCreated` now derives `marketId = keccak256(abi.encodePacked(token0, token1, fee, uint32(expiry − createdAt)))` via `helpers.deriveMarketId`. **Correction to the original note:** this is `abi.encodePacked` (TIGHT packing, 20+20+3+4 = 47 bytes) — **NOT** `ethereum.encode`, which ABI-pads every operand to 32 bytes and would hash a different (128-byte) preimage → non-matching id. `deriveMarketId` concatenates the raw big-endian bytes of each field at its on-chain width (`uintBytesBE`; note graph-ts `ByteArray.fromI32` is little-endian, unusable here). `token0`/`token1`/`fee` are reused from the existing `NPM.positions` bind; `expiry`/`createdAt` come from the swap record via `try_swaps(swapId)` (`expiry − createdAt == cfg.durationSeconds` on-chain, so the id matches both `registerMarket` and `_marketIdForSwap`). Verified statically against `InflexionCore.sol` L355/L590/L1146/L1157.
2. `Swap.market` set; `Market` lifetime counters bumped (`totalSwaps`/`totalV0`/`totalPremium` in `handleSwapCreated`; `pathBFills` in `handleSwapPriced` where the path is known; `totalSettled`/`totalPayout` in `handleSwapSettled`); `MarketStateSnapshot` upserted in `handleCollateralLocked` from `ConvexityVault.lockedByMarket(marketId)` + `utilizationWad()`/`concentrationWad()` (all three getters confirmed on-chain — `ConvexityVault.sol` L68/L155/L163). Files changed: `src/helpers.ts`, `src/inflexion-core.ts`, `src/convexity-vault.ts`, `abis/ConvexityVault.json` (added the 3 getters), `scripts/gen-manifest.mjs` (added `Market`/`MarketStateSnapshot` to the vault data source), `subgraph.yaml` (regenerated).
3. _(still optional, manifest-only)_ add UnderwriterVault/ILVault data sources if on-chain Path-B MM-collateral / fee history is wanted (today MM PnL is reconstructed from InflexionCore events, and live LP fees come from the SDK).

**✅ Verified (2026-06-05, on the Windows dev machine — no separate home-PC step needed):**

- **`graph build` (asc → WASM) passes** — all three data sources (`InflexionCore`/`ConvexityVault`/`VolOracle.wasm`) compile; the AssemblyScript mapping bodies type-check (`graph codegen` validates schema/ABIs/manifest + generated types only, NOT the bodies).
- **keccak `marketId` cross-check passes bit-for-bit** — `deriveMarketId`'s tight-packed preimage reproduces the LIVE on-chain marketIds (`marketId_fee500_7d` `0xd1aa1fad…5ca3`, `shortMarketId_fee500_300s` `0xacbeed…3e7e`) for both demo markets, three independent ways (viem `encodePacked`, a manual replica of `deriveMarketId`, and the registry value). Now locked by `packages/contracts/test/MarketIdParity.t.sol` + `packages/sdk/src/marketid.parity.test.ts` (both pinned to the live ids).

**⚠️ Found + fixed during this verification — branch `fix/subgraph-event-order-aggregation` (commit `f6f3872`, NOT yet merged):** the WASM build is green, but a runtime event-order bug it cannot catch surfaced. The contract emits `SwapCreated → QuoteFilled → SwapPriced`, but `handleQuoteFilled` read `poolLoadWad`/`cappedAtMaxIL` — written only by the LATER `handleSwapPriced` — so Signal-2 `sumSpreadWad` was never accumulated and capped Path-B fills corrupted `sumMMLoadBps` (breaking the NON-CIRCULAR invariant). The spread + non-circular MM-load accumulation was relocated into `handleSwapPriced`. Also hardened: `NPM_ADDRESS` templated from the deployment registry (`src/generated-addresses.ts`, regenerated by `prepare:manifest`) instead of hardcoded; the two marketId parity tests above. **Merge this branch BEFORE the redeploy** — the moat dataset begins at the redeploy block and these aggregates are unreconstructable retroactively.

## Redeploy steps (run once, on WSL2)

1. ✅ Size-pass `InflexionCore` back ≤ 24,576 B — **DONE** (`optimizer_runs` 1500 → 23,934 B, see above); just rebuild + deploy with the committed `foundry.toml`.
2. `forge script script/Deploy.s.sol` — redeploy the Solidity stack (InflexionCore + the `CvammPricing` lib with `loadComponents`); the Stylus FairValueOracle (`0x10E3…`) is UNCHANGED — just `setCvamm` back to it.
3. Re-`setLoadParams` (from the params schema), re-`registerMarket`, `setCvammEnabled`.
4. Re-seed via `SeedDemo.s.sol` / `DemoLifecycle.s.sol`. The residual swap-#1 settle becomes moot.
5. Update `deployments/arbitrum-sepolia.json` (addresses + deploy block); regenerate the subgraph manifest (addresses + `startBlock`) from it: `SUBGRAPH_START_BLOCK=<deployBlock> pnpm --filter @inflexion/subgraph prepare:manifest`. The moat dataset begins at this block.
6. Deploy the subgraph from the home PC (network/IPFS needed; NOT a CI step): `pnpm --filter @inflexion/subgraph build:wasm` then `pnpm --filter @inflexion/subgraph deploy`. CI only runs `graph codegen` (offline typegen); `graph build`/`graph deploy` are home-PC-only scripts.
7. Point the API at the deployed subgraph: set `SUBGRAPH_URL=<studio query URL>` on the API service (plus `ARBITRUM_SEPOLIA_RPC` for the live surfaces and `DEMAND_LOG`/`COMPETITION_LOG` for the telemetry halves). Until `SUBGRAPH_URL` is set the subgraph-backed endpoints honestly return a typed `pending` body; the live + telemetry endpoints already serve real data.
8. Point the SDK/engine address config at the registry (no hardcoded addresses).
