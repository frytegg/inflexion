# Engine telemetry — day-one capture of the two DYNAMIC moat signals

> **Why this exists, in one sentence:** two of the moat's signals are
> **unreconstructable retroactively**, so the engine must log them from the very
> first interaction — _before_ any `/data` endpoint, API, or subgraph exists to
> serve them.

On-chain we only ever observe **realized fills**. Everything an LP priced but did
not buy, and every MM quote that lost or was withdrawn, leaves **no on-chain
trace by design** (invariant I7: an unchosen quote touches no nonce / capacity).
If we do not capture it now, it is gone forever. See
`docs/ACCESS_LAYER_ARCHITECTURE.md` §5.4 (Signal 4), §5.6 (off-chain telemetry),
and the redeploy checklist's "Off-chain surfaces required" section.

## The two signals captured here

| Signal                                          | What                                                                                                                          | Where it would otherwise be lost                                                                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Signal 4 — latent / unfilled demand**         | Which geometry an LP _priced_ (via SDK `previewPremium`) or _asked the relayer about_ (`GET /quote`) but may not have bought. | The chain sees only realized `SwapCreated` fills; unfilled interest never reaches it.                                                                         |
| **Signal 2 — dynamic half (quote competition)** | EVERY MM quote the relayer receives over WS — **winners AND losers / withdrawn** — with timestamps.                           | `store.ts` only keeps the _latest_ stored quote per (market, MM); the competing field (who else quoted, how wide, who widened/withdrew under stress) is lost. |

These are the _dynamic_ halves. The _structural_ halves (realized demand surface,
clearing-load decomposition) are fully on-chain and populate from the planned
`SwapPriced` / `QuoteFilled` events at the single redeploy.

## What the engine logs (live in `packages/engine`)

Append-only **JSONL** (one JSON object per line), mirroring the existing
accepted-quote log in `store.ts`. The writer is **best-effort**: a telemetry
failure (full disk, bad path, missing sink) NEVER breaks a quote ack, a preview,
or a `/quote` request — graceful degradation is a first-class property.

Source: `packages/engine/src/telemetry.ts` (`TelemetrySink`), wired into
`server.ts` and exposed via `index.ts` env vars.

### Demand log (Signal 4) — `DEMAND_LOG`

Written on every `GET /quote` request and every `POST /telemetry/preview` ping.

```jsonc
// schema: DemandRecord
{
  "ts": 1900000000,
  "marketId": "0x…", // bytes32, lowercased
  "widthBucket": "tight", // tight|medium|wide|full|unknown
  "distanceBucket": "at-edge", // at-edge|near|mid|deep|unknown
  "durationBucket": "week", // hour|day|week|month|longer|unknown
  "previewedPremium": "777", // optional, decimal string (bigint-safe); absent for a bare /quote
  "filled": false, // ALWAYS false — this is the latent/unfilled half
  "source": "preview",
} // "preview" | "quote-request"
```

No PII, no raw geometry, no `tokenId`, no addresses — only **coarse buckets** +
the `marketId`. The SDK computes the buckets client-side and POSTs only the
labels.

### Competition log (Signal 2) — `COMPETITION_LOG`

Written for **every** inbound WS quote — accepted (winner) and rejected
(loser / stale / withdrawn-equivalent).

```jsonc
// schema: CompetitionRecord
{
  "ts": 1900000000,
  "marketId": "0x…", // bytes32, lowercased
  "mm": "0x…", // MM address, lowercased
  "loadBps": 500,
  "validUntil": "1900000010", // uint64 as decimal string (bigint-safe)
  "accepted": true, // true iff stored as a live candidate (verify + freshness passed)
  "reason": "bad-signature",
} // present only when accepted=false (mirrors the WS rejection)
```

## SDK integration (the `previewPremium` ping)

The SDK's `previewPremium` SHOULD optionally POST a lightweight, best-effort
telemetry ping. It must **never block or fail the preview** — fire-and-forget,
swallow any network error.

```
POST /telemetry/preview          (engine, default :8787)
content-type: application/json
{ "marketId": "0x…",
  "widthBucket": "tight",
  "distanceBucket": "at-edge",
  "durationBucket": "week",
  "previewedPremium": "777" }     // optional decimal string
→ 202 { "ok": true,  "logged": true|false }   // logged=false if no sink configured
→ 400 { "ok": false, "reason": "marketId (bytes32 hex) required" }
```

## Operating the engine with telemetry on

Set these env vars from the FIRST deploy (see `src/index.ts`):

```
DEMAND_LOG=/var/lib/inflexion/demand.jsonl        # Signal 4
COMPETITION_LOG=/var/lib/inflexion/competition.jsonl  # Signal 2
QUOTE_LOG=/var/lib/inflexion/quotes.jsonl         # existing accepted-quote log
```

`GET /health` reports sink status:
`{ "ok": true, "markets": N, "telemetry": { "demand": true, "competition": true } }`.

## Post-redeploy: where this data goes

At the single redeploy the API (`packages/api`) reads these JSONL logs and serves
the aggregated streams:

- `GET /data/demand-requests` ← demand log (Signal 4 latent demand)
- `GET /data/quote-competition` ← competition log (Signal 2 dynamic half)

Each carries the maturity disclaimer (the dataset begins at the first interaction
logged here). The on-chain `SwapPriced` / `QuoteFilled` events then join the
_structural_ halves. Until then, these endpoints are absent and the SDK/API return
typed degraded results — but the data is **being captured now**, which is the
whole point.
