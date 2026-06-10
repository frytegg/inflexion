# @inflexion/backend

The combined, hosted backend — **one process, one port**:

- `/` → the public REST API ([`@inflexion/api`](../../packages/api)) — markets, pool, pricing, swaps, `data/*` (the five signals), sigma, mm, `/health`.
- `/engine/*` → the Path-B quote relayer ([`@inflexion/engine`](../../packages/engine)) — `GET`/`POST /engine/quote`, `POST /engine/telemetry/preview`, `/engine/health`.

Co-locating them lets the API read the **same** telemetry JSONL the engine writes (`DEMAND_LOG` / `COMPETITION_LOG` on a shared volume), so the off-chain halves of **Signal 2** (quote competition) and **Signal 4** (latent demand) are live alongside the subgraph-backed and live-RPC signals.

## Run locally

```bash
pnpm --filter "@inflexion/backend..." build   # build sdk + engine + api
SUBGRAPH_URL=https://api.studio.thegraph.com/query/1754692/inflexion-arb-sepolia/version/latest \
ARBITRUM_SEPOLIA_RPC=https://sepolia-rollup.arbitrum.io/rpc \
DEMAND_LOG=./.data/demand.jsonl COMPETITION_LOG=./.data/competition.jsonl \
pnpm --filter @inflexion/backend start
# → http://localhost:8088  (API)  +  http://localhost:8088/engine  (relayer)
```

`pnpm --filter @inflexion/backend dev` runs it with `node --watch`. The `start` script auto-loads a root `.env` if present (`node --env-file-if-exists=../../.env`).

## Environment

| Var | Required | Purpose |
| --- | --- | --- |
| `PORT` | host-injected | Listen port (Railway sets this; default `8088`). |
| `SUBGRAPH_URL` | recommended | Subgraph query endpoint. Absent → history/aggregate surfaces return typed `pending`. |
| `ARBITRUM_SEPOLIA_RPC` | recommended | RPC for the live current-load surface (or `SEPOLIA_RPC`). Absent → live endpoints `pending`. |
| `CHAIN_ID` | no | Default `421614` (Arbitrum Sepolia). |
| `VERIFYING_CONTRACT` | no | InflexionCore address for EIP-712 quote verification. Default = the address registry. |
| `DEMAND_LOG` | for Signal 4 | JSONL path on the shared volume, e.g. `/data/demand.jsonl`. |
| `COMPETITION_LOG` | for Signal 2 | JSONL path on the shared volume, e.g. `/data/competition.jsonl`. |
| `QUOTE_LOG` | no | Accepted-quote JSONL (optional). |

## Deploy to Railway

The repo ships [`railway.json`](../../railway.json) (Dockerfile builder → [`apps/backend/Dockerfile`](./Dockerfile), healthcheck `/health`).

```bash
npm i -g @railway/cli      # one-time
railway login              # opens a browser
railway init               # create/link a project (run from the repo root)
railway up                 # build + deploy the Dockerfile
```

Then in the Railway service dashboard:

1. **Variables** — set `SUBGRAPH_URL`, `ARBITRUM_SEPOLIA_RPC`, `DEMAND_LOG=/data/demand.jsonl`, `COMPETITION_LOG=/data/competition.jsonl`. (`PORT` is injected; `CHAIN_ID`/`VERIFYING_CONTRACT` default correctly.)
2. **Volume** — add a volume mounted at **`/data`** so the telemetry JSONL survives restarts and is shared between the API and engine halves.
3. **Networking** — generate a public domain. The healthcheck hits `/health`.

## After deploy — wire the dApp

With the Railway domain `https://<app>.up.railway.app`, set in `apps/web/.env.local` (and the web host):

```
NEXT_PUBLIC_API_URL=https://<app>.up.railway.app
NEXT_PUBLIC_ENGINE_URL=https://<app>.up.railway.app/engine
```

The engine lives under the `/engine` prefix, so the SDK's `${engineBaseUrl}/quote` resolves to `…/engine/quote`. WebSocket quote-streaming (the `mm-bot`) is a local-dev tool and is not exposed by the hosted backend; browser MMs publish via `POST /engine/quote`.
