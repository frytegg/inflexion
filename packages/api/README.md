# @inflexion/api

Public, **read-only, cached** facade over `@inflexion/subgraph` (history/aggregates)

- a few **live RPC reads** (via `@inflexion/sdk`) + the **engine telemetry sinks**
  (the dynamic moat halves). **No wallet, no RPC key for consumers.**

The three-layer routing rule (`docs/ACCESS_LAYER_ARCHITECTURE.md` §1):

> Needs history or an aggregate → **subgraph (consumed via this API)**.
> Needs frictionless public access with no wallet and no RPC key → **this API**.

## Pricing is NOT duplicated

The live surfaces (`/pool/load-surface`, `/pricing/preview`) reuse the SDK's
`DataClient.getCurrentLoadSurface` multicall, and `/pool` reuses
`DepositorClient.getVaultState`. The API never re-derives the fair rate or the load
stack — the SDK owns pricing.

## Graceful degradation (never crashes)

The subgraph is **not deployed yet** and the rich events are not live until the
single redeploy. Every subgraph-backed endpoint returns a typed `pending` body that
**embeds the exact GraphQL query** it will run at the redeploy. The LIVE endpoints
(current pool-load via the SDK; engine telemetry reads) return real data **now**.

| Backing absent | Result                                                           |
| -------------- | ---------------------------------------------------------------- |
| subgraph url   | `{ available:false, reason:'subgraph-not-deployed', query }`     |
| RPC            | `{ available:false, reason:'rpc-unavailable' }` (live endpoints) |
| telemetry sink | `{ available:false, reason:'telemetry-sink-absent' }`            |

## Scripts

| Script       | What                                                   |
| ------------ | ------------------------------------------------------ |
| `pnpm build` | `tsc` (offline)                                        |
| `pnpm test`  | `vitest run` (offline — mocked subgraph/RPC/telemetry) |
| `pnpm start` | run the `node:http` server                             |
| `pnpm dev`   | `tsx watch`                                            |

## Env (server)

```
PORT=8088
SUBGRAPH_URL=<deployed subgraph GraphQL endpoint>   # absent ⇒ subgraph surfaces pending
ARBITRUM_SEPOLIA_RPC=<rpc>                           # absent ⇒ live endpoints pending
DEMAND_LOG=/var/lib/inflexion/demand.jsonl           # engine Signal-4 sink (read-only)
COMPETITION_LOG=/var/lib/inflexion/competition.jsonl # engine Signal-2 sink (read-only)
```

## OpenAPI

`GET /openapi.json` serves the OpenAPI 3.1 document; `GET /docs` serves a Swagger-UI
shell that renders it. Both are LIVE (no backing needed).

## Endpoints (§7.1)

**System / docs:** `GET /health`, `/openapi.json`, `/docs`.

**Live now (no subgraph needed):**

- `GET /pool?marketIds` — vault state composite (NAV, senior/junior, util, conc, the
  two skews, regime); SDK `getVaultState`; **claim B** (capital NOT guaranteed).
- `GET /pool/load-surface?marketIds` — current pool-load surface (SDK multicall).
- `GET /pricing/preview?marketId&a&b&maxIL` — cached fair + pool premium (SDK).
- `GET /data/demand-requests` (latent half) + `GET /data/quote-competition` — engine
  telemetry sinks (Signals 4/2 dynamic halves).

**Subgraph-pending until the redeploy** (typed `pending` with the embedded query):

- `GET /markets`, `/markets/:id`
- `GET /pool/nav-history?bucket` — **claim B**
- `GET /swaps?status&mm&market&first`, `/swaps/:swapId` — **claim A** (payout)
- `GET /data/load-surface?marketId` (Signal 1), `/data/convexity-surface` (Signal 1/2),
  `/data/term-structure?width&distance` (Signal 3), `/data/demand-requests` (realized
  half, Signal 4), `/data/net-gamma` + `/data/supply-depth` (Signal 5)
- `GET /mm/:address/fills`, `/sigma/:token/history`
