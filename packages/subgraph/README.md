# @inflexion/subgraph

The Graph indexer that reconstructs Inflexion's on-chain **event history** into the
queryable store feeding the public API (`@inflexion/api`). It is **internal
infrastructure** — nobody queries it directly in production except the API.

It indexes the on-chain event stream into the five **data-moat signals**
(`docs/ACCESS_LAYER_ARCHITECTURE.md` §5–6) as both a **current snapshot** and a
**historical series**.

## CI-safe build (offline)

| Script                  | What it does                                                                     | Network?            |
| ----------------------- | -------------------------------------------------------------------------------- | ------------------- |
| `pnpm build`            | `graph codegen` — typegen from the schema + ABIs (validates everything compiles) | **No**              |
| `pnpm codegen`          | alias of the above                                                               | **No**              |
| `pnpm build:wasm`       | `graph codegen && graph build` — full AssemblyScript → WASM compile              | Yes (downloads asc) |
| `pnpm deploy`           | `graph deploy` to the Studio endpoint                                            | Yes (IPFS)          |
| `pnpm prepare:manifest` | regenerate `subgraph.yaml` from the deployment registry                          | No                  |

`build` = `graph codegen` so `pnpm -r build` stays green **offline** in CI. There is
**no `test` script** so `pnpm -r test` does not invoke matchstick (which needs a
toolchain download). The full WASM build + deploy are the home-PC scripts.

## Manifest is templated from the registry

`subgraph.yaml` is **generated** by `scripts/gen-manifest.mjs` from
`deployments/arbitrum-sepolia.json` (the single address source — never hardcode an
address). It is **regenerated at the single redeploy** with the redeploy block as
`startBlock` — **the moat dataset begins there**. The rich events
(`QuoteFilled` / `SwapPriced`) are coded but do not fire until the redeploy, so their
handlers are simply idle pre-redeploy.

```sh
SUBGRAPH_START_BLOCK=<deployBlock> pnpm prepare:manifest
```

## Events indexed

- **InflexionCore:** `MarketRegistered`, `MarketDeactivated`, `TreasurySet`,
  `CvammConfigured`, `CvammFrozen`, `CvammEnabledSet`, `LoadParamsSet`, `SwapCreated`,
  `SwapPriced`_, `QuoteFilled`_, `SwapRouted`, `SwapSettled`, `NoncesCancelled`.
- **ConvexityVault:** `Deposited`, `WithdrawRequested`, `Withdrawn`, `PremiumAccrued`,
  `CollateralLocked`, `SettlementReleased`, `JuniorLoss`.
- **VolOracle:** `Poked`, `Initialized`.

\* coded-but-not-live until the redeploy (indexed and ready).

## ABIs are local

`abis/*.json` are hand-written minimal ABIs (events + the `swaps` getter + NPM
`positions`) so `graph codegen` runs **fully offline**.
