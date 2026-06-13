# @inflexion/web — the Inflexion dApp

Next.js (App Router) frontend for the Inflexion protocol on Arbitrum Sepolia.
Marketing landing (`inflexion.xyz`) + the dApp (`app.inflexion.xyz`) in one app via
`(marketing)` / `(app)` route groups + domain middleware. All pages are wired to
**real on-chain reads/writes** through `@inflexion/sdk`.

> Wired to the protocol through `@inflexion/sdk`. Protocol documentation lives in
> `apps/docs` (Mintlify).

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
# create apps/web/.env.local with the NEXT_PUBLIC_* block from the root .env.example
# (set NEXT_PUBLIC_RPC_URL + NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID)

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
- **History (via the REST API):** per-market history/volume, NAV history, the
  time-series moat signals, and precise MM fill attribution are served from the
  subgraph through the public API (`NEXT_PUBLIC_API_URL`). When it is unset these
  render an honest "pending" state, never an error.

## Deploy (Vercel)

The app deploys to Vercel from this monorepo. `vercel.json` (in this folder) sets the
framework and a build command that compiles the workspace deps (`@inflexion/engine` →
`@inflexion/sdk`) before `next build`.

**Vercel project settings:**

- **Root Directory:** `apps/web`
- Install + build commands come from `vercel.json` — no dashboard override needed.

**Environment variables** (set for Production + Preview — all public, no secrets):

| Variable                               | Value                                                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_RPC_URL`                  | an Arbitrum Sepolia RPC (`https://sepolia-rollup.arbitrum.io/rpc`, or a dedicated Alchemy/Infura URL for demos) |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | a WalletConnect / Reown project id (free, from cloud.reown.com)                                                 |
| `NEXT_PUBLIC_API_URL`                  | `https://inflexion-backend.onrender.com`                                                                        |
| `NEXT_PUBLIC_ENGINE_URL`               | `https://inflexion-backend.onrender.com/engine`                                                                 |

On a `*.vercel.app` host the domain middleware passes through, so the full app
(marketing + every route) is reachable. The split to `inflexion.xyz` /
`app.inflexion.xyz` activates only when those domains are attached.

## Notes

- All addresses load from `deployments/arbitrum-sepolia.json` via the SDK — never
  hardcoded.
- dUSDC/USDC are **6 decimals**; payout is `min(realized IL, MaxIL)` — the cap is
  load-bearing. Depositor/MM **capital is not guaranteed**.
