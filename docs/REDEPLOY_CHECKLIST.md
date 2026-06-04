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

## ⚠️ Size: `InflexionCore` is 213 B over EIP-170

After the events, `InflexionCore` is **24,789 B vs the 24,576 B limit (+213 B)**. `forge build`/`forge test` are unaffected (revm doesn't enforce EIP-170; CI is green), but **the redeploy WILL fail to deploy until this is reduced.** Reclaim options for the redeploy size-pass (cheapest first):

1. Lower `optimizer_runs` (currently 2000 → try 1500/1000) — global gas trade-off.
2. Move the `SwapPriced` emit into a `public` library function (event + emit off-core).
3. Further library extraction (the home-PC pattern that got core to 23.9 KB).

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

## Redeploy steps (run once, on WSL2)

1. Size-pass `InflexionCore` back ≤ 24,576 B (above).
2. `forge script script/Deploy.s.sol` — redeploy the Solidity stack (InflexionCore + the `CvammPricing` lib with `loadComponents`); the Stylus FairValueOracle (`0x10E3…`) is UNCHANGED — just `setCvamm` back to it.
3. Re-`setLoadParams` (from the params schema), re-`registerMarket`, `setCvammEnabled`.
4. Re-seed via `SeedDemo.s.sol` / `DemoLifecycle.s.sol`. The residual swap-#1 settle becomes moot.
5. Update `deployments/arbitrum-sepolia.json` (addresses + deploy block); regenerate the subgraph manifest (addresses + `startBlock`) from it: `SUBGRAPH_START_BLOCK=<deployBlock> pnpm --filter @inflexion/subgraph prepare:manifest`. The moat dataset begins at this block.
6. Deploy the subgraph from the home PC (network/IPFS needed; NOT a CI step): `pnpm --filter @inflexion/subgraph build:wasm` then `pnpm --filter @inflexion/subgraph deploy`. CI only runs `graph codegen` (offline typegen); `graph build`/`graph deploy` are home-PC-only scripts.
7. Point the API at the deployed subgraph: set `SUBGRAPH_URL=<studio query URL>` on the API service (plus `ARBITRUM_SEPOLIA_RPC` for the live surfaces and `DEMAND_LOG`/`COMPETITION_LOG` for the telemetry halves). Until `SUBGRAPH_URL` is set the subgraph-backed endpoints honestly return a typed `pending` body; the live + telemetry endpoints already serve real data.
8. Point the SDK/engine address config at the registry (no hardcoded addresses).
