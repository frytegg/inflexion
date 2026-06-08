# @inflexion/web — the Inflexion dApp

Next.js (App Router) frontend for the Inflexion protocol on Arbitrum Sepolia.
Marketing landing (`inflexion.xyz`) + the dApp (`app.inflexion.xyz`) in one app via
`(marketing)` / `(app)` route groups + domain middleware. All pages are wired to
**real on-chain reads/writes** through `@inflexion/sdk`.

> Architecture, page map, and design tokens: `FRONTEND_PLAN.md`, `DESIGN_TOKENS.md`.
> The exact SDK/engine/API wiring: `INTEGRATION_MAP.md`. (Design is functional-first;
> a visual pass refines it.)

## Pages

| Route         | What it does                                                        | On-chain        |
| ------------- | ------------------------------------------------------------------- | --------------- |
| `/`           | Marketing landing                                                   | —               |
| `/protect`    | LP buys in-range IL protection (preview → approve+buy → settle)     | `lp.*`          |
| `/earn`       | Depositor underwrites via the dual-tranche vault (deposit/withdraw) | `depositor.*`   |
| `/underwrite` | MM signs EIP-712 quotes + posts collateral (Path B)                 | `mm.*` + engine |
| `/dashboard`  | Your positions across roles + settle/withdraw/cancel                | all             |
| `/markets`    | The 9 markets, live pricing                                         | `data.*`/`mm.*` |
| `/data`       | The data-moat showcase (live load surface + pending history)        | `data.*`        |

## Run it locally

```bash
# from the repo root
pnpm install
cp apps/web/.env.example apps/web/.env.local   # set NEXT_PUBLIC_RPC_URL + WalletConnect id

# 1) the dApp (http://localhost:3000)
pnpm --filter @inflexion/web dev

# 2) the Path-B engine (http://localhost:8787) — optional; Path A works without it
pnpm --filter @inflexion/engine dev

# 3) the REST API (http://localhost:8088) — optional (external consumers / history)
pnpm --filter @inflexion/api dev
```

Then connect a wallet on **Arbitrum Sepolia**, get demo tokens (dUSDC from the
faucet / mint, dWETH), and use the pages. Reads work immediately; writes need a
connected wallet.

## What's live vs pending

- **Live now (RPC):** premium preview, payoff, buy/settle (Path A), vault
  deposit/withdraw, market pricing, the current load surface, σ_ref, the book
  (on-chain scan), coarse fills.
- **Path B:** needs the engine running + `NEXT_PUBLIC_ENGINE_URL` set (the MM signs
  a quote on `/underwrite`, the engine relays it, the LP's `createSwapRouted` picks
  the cheaper of pool vs MM).
- **Pending the subgraph (task #33):** per-market history/volume, NAV history, the
  time-series moat signals, precise MM fill attribution. These render an honest
  "pending" state, never an error.

## Notes

- All addresses load from `deployments/arbitrum-sepolia.json` via the SDK — never
  hardcoded.
- dUSDC/USDC are **6 decimals**; payout is `min(realized IL, MaxIL)` — the cap is
  load-bearing. Depositor/MM **capital is not guaranteed**.
