# 06 — Engine + Public REST API

> Knowledge-base source material for the public docs and judge Q&A. Covers the two
> off-chain services that surround Inflexion's on-chain core:
>
> - **`@inflexion/engine`** — the thin **Path-B quote relayer** (market-maker rail).
> - **`@inflexion/api`** — the public **read-only REST facade** over the subgraph,
>   a small set of live RPC reads, and the engine's telemetry sinks.
>
> Both are deliberately thin, framework-free (`node:http`), and **never settle, match,
> or hold a wallet**. The chain is the authority; these are convenience + data surfaces.
> Every technical claim below is cited `file:line`. Live deployment: Arbitrum Sepolia
> (chainId `421614`), fresh full redeploy 2026-06-05; addresses in
> `deployments/arbitrum-sepolia.json`. dUSDC = 6 decimals (numéraire). The subgraph
> is **not yet deployed**, so subgraph-backed API surfaces return a typed *pending*
> state (this is by design, not a bug — see §B.4).

---

## Part A — The Engine (`@inflexion/engine`): the Path-B relayer

### A.0 What it is, and what it deliberately is NOT

The engine is a **thin** off-chain relayer for the **optional Path-B (market-maker)
rail**. It does **not** match or settle — *the chain does that*
(`packages/engine/src/server.ts:1-12`; `packages/engine/README.md:1-14`). Its entire
job is three things:

1. Accept EIP-712 signed quotes streamed by a market maker over **WebSocket**, verify
   the signature + a light freshness gate, and store the latest per `(market, MM)`.
2. Serve the **cheapest currently-valid quote** for a market over **`GET /quote`**.
3. Capture the **two day-one dynamic moat signals** (latent demand, quote competition)
   into append-only JSONL sinks that are otherwise *unreconstructable retroactively*.

**Why it must stay thin (the architectural WHY):** the final premium is
*position-specific* and is derived **on-chain** at `createSwapRouted` as
`FairPremium · (1 + loadBps)` (`server.ts:8-11`, `:207-210`). The relayer therefore
returns the *signed quote + its `loadBps`*, not a dollar premium — it cannot compute
the dollar premium without the LP's exact position geometry + an RPC read of
`FairPremium` (`README.md:46-49`). Pushing matching/settlement off-chain would
reintroduce trust; keeping it on-chain is what makes the no-bad-debt guarantee hold.

**Why Path A needs no engine at all:** Path A (the cvAMM pool) is *always-on,
signature-free* — a pooled vault underwrites with no relayer in the loop
(`README.md:12-14`). The engine exists **only** so a sophisticated MM can *compete on
price* against the pool. `createSwapRouted` then gives the LP the cheaper of
{pool, MM quote}. The engine is pure upside: if no MM is connected, Path A still
clears every position.

### A.1 Entry point + environment (`packages/engine/src/index.ts`)

The process reads config from env and starts the relayer (`index.ts:21-36`):

| Env var              | Default                              | Meaning |
| -------------------- | ------------------------------------ | ------- |
| `PORT`               | `8787`                               | HTTP + WS listen port (`index.ts:21`) |
| `CHAIN_ID`           | `421614` (Arbitrum Sepolia)          | EIP-712 domain `chainId` (`index.ts:22`) |
| `VERIFYING_CONTRACT` | registry `core.inflexionCore`        | EIP-712 `verifyingContract` = `InflexionCore` (`index.ts:23-24`) |
| `QUOTE_LOG`          | unset                                | append-only JSONL of *accepted* quotes (`index.ts:25`) |
| `DEMAND_LOG`         | unset                                | **day-one** Signal-4 latent-demand JSONL (`index.ts:26`) |
| `COMPETITION_LOG`    | unset                                | **day-one** Signal-2 quote-competition JSONL (`index.ts:27`) |

`VERIFYING_CONTRACT` and `CHAIN_ID` default from the **deployment registry**, never
hardcoded: `packages/engine/src/addresses.ts:13-22` reads
`deployments/arbitrum-sepolia.json` directly (the engine cannot import
`@inflexion/sdk` — the SDK depends on the engine, which would be a cycle —
`addresses.ts:5-8`). **Why this matters:** a stale hardcoded core would sign quotes
against a *dead EIP-712 domain*, and on-chain `createSwapRouted` would then reject
**every** Path-B fill (`addresses.ts:8-11`). The current default resolves to
`InflexionCore = 0xC19865cF8403F59B8Eca835833aFEe3Aa8DA4848`
(`deployments/arbitrum-sepolia.json:49`).

**`DEMAND_LOG` / `COMPETITION_LOG` must be set from the first deploy.** These two
signals are *unreconstructable retroactively* — unfilled/previewed interest never
reaches the chain (`index.ts:13-15`). See §A.6.

Startup logs the four surfaces (`index.ts:39-45`); SIGINT/SIGTERM trigger a graceful
`close()` that shuts the WS server then the HTTP server (`index.ts:47-51`,
`server.ts:264-269`).

### A.2 The `SignedQuote` — the on-the-wire unit (`packages/engine/src/quote.ts`)

`quote.ts` is the **single source of truth** for how a Path-B MM signs a quote and
how anyone verifies it off-chain. The field order, types, and the domain
`("Inflexion", "1")` **must match `InflexionCore.SignedQuote` /
`SIGNED_QUOTE_TYPEHASH` exactly**, or on-chain verification in
`createSwap`/`createSwapRouted` rejects the signature (`quote.ts:1-9`). The SDK and the
MM bot both import this module (`README.md:16-26`).

**EIP-712 domain** (`quote.ts:19-22`): `{ name: 'Inflexion', version: '1', chainId,
verifyingContract }`.

**The 13 quote fields** (struct/field order = signing order — `quote.ts:25-41`):

| Field              | Solidity type | TS type   | Meaning |
| ------------------ | ------------- | --------- | ------- |
| `mm`               | `address`     | `Address` | MM signer; the recovered signer must equal this (`quote.ts:121-129`) |
| `marketId`         | `bytes32`     | `Hex`     | the market this quote is for (**per-market, never per-NFT**) |
| `loadBps`          | `uint16`      | `number`  | spread over the on-chain `FairPremium`; capped at `loadParams.maxLoadBps` (`quote.ts:57`) |
| `minMaxILRatioBps` | `uint16`      | `number`  | lower bound of the accepted MaxIL-ratio band |
| `maxMaxILRatioBps` | `uint16`      | `number`  | upper bound of the accepted MaxIL-ratio band |
| `quotePrice`       | `uint128`     | `bigint`  | oracle price the MM signed against — anchors the Fork-2 band check (`quote.ts:61`) |
| `priceBandBps`     | `uint16`      | `number`  | ± band around `quotePrice` the MM tolerates |
| `model`            | `uint8`       | `number`  | `CollateralModel`: `FULL=0`, `PARTIAL=1` (FULL is the only v1 mode — `quote.ts:47-48`) |
| `partialRatioBps`  | `uint16`      | `number`  | PARTIAL only (0 in FULL) |
| `maxNotionalV0`    | `uint128`     | `bigint`  | capacity ceiling (notional V0 the MM will fill against this quote) |
| `validUntil`       | `uint64`      | `bigint`  | absolute GTD expiry timestamp (`quote.ts:67`) |
| `quoteId`          | `bytes32`     | `Hex`     | the MM's logical quote identifier |
| `nonce`            | `uint256`     | `bigint`  | bitmap nonce — a cancelled bit cannot fill (invariant I7) |

The canonical type-string is mirrored in `SIGNED_QUOTE_TYPE_STRING` (`quote.ts:44-45`)
for cross-checks; it is byte-identical to
`InflexionCore.SIGNED_QUOTE_TYPEHASH`'s pre-image
(`packages/contracts/src/InflexionCore.sol:142`).

**The quote is PER-MARKET, not per-NFT.** This is load-bearing for the whole model:
MaxIL is pure geometry, frozen at creation, L-independent in the fair-rate sense, which
makes positions **fungible** to an underwriter within a market. So an MM quote is a
*load + a MaxIL-ratio band + capacity*, never tied to one position. That is exactly
the shape encoded here (`loadBps` + `[minMaxILRatioBps, maxMaxILRatioBps]` +
`maxNotionalV0`).

**Signing / verifying (`quote.ts:80-129`):**

- `quoteDigest(quote, chainId, vc)` → the EIP-712 digest `_hashTypedDataV4(hashQuote(q))`
  that the contract computes (`quote.ts:79-87`).
- `signQuote(privateKey, quote, chainId, vc)` → `{ quote, signature }` envelope
  (`quote.ts:90-104`).
- `recoverQuoteSigner(env, ...)` → the EOA signer (`quote.ts:107-119`).
- `verifyQuote(env, ...)` → **true iff** the signature recovers to `quote.mm`,
  case-insensitively (`quote.ts:122-129`). This is the **EOA path**; EIP-1271 contract
  signers are verified *on-chain* only (`quote.ts:106`).

**Wire codec (`quote.ts:131-186`):** `bigint` is not JSON-serializable, so the WS
protocol and the JSONL logs encode every `uint128/uint64/uint256` field as a **decimal
string**. `encodeQuote(q)` produces the `QuoteWire` (bigints → strings); `decodeQuote(w)`
parses them back. The small `uint16/uint8` fields stay as JS `number` (always `< 2^53`,
safe — `quote.ts:50-53`).

### A.3 On-chain bounds the off-chain quote must respect

The relayer applies only a **light** freshness gate; the chain re-checks everything.
The authoritative bounds (from `InflexionCore.sol`) that an MM's quote must satisfy or
`createSwapRouted` reverts / falls back to Path A:

- **Validity window:** `validUntil - block.timestamp ∈ [5, 15] s`
  (`VALIDITY_MIN_S = 5`, `VALIDITY_MAX_S = 15` — `InflexionCore.sol:88-90`,
  enforced `:878-881`). This confirms the `quote.ts:67` comment ("bounded on-chain to
  now + [5, 15] s"). The MM bot uses `TTL = 10s` and re-issues every 5s
  (`mm-bot.ts:21-22`), comfortably inside the window. **Why so short:** firm GTD quotes
  with a tiny TTL + an oracle-anchored band are the *no-last-look* design — the MM
  cannot pick off stale prices, and a stale quote simply voids itself.
- **Price band:** `priceBandBps ∈ [25, 500] bps` (`PRICE_BAND_MIN_BPS = 25` = 0.25%,
  `PRICE_BAND_MAX_BPS = 500` = 5% — `InflexionCore.sol:84-86`). At `createSwap` the
  contract reverts iff `absBps(P_live, quotePrice) > priceBandBps` (invariant I9 /
  Fork 2 — `InflexionCore.sol:890-894`). The band check **reuses the same oracle read
  that pinned P0** (`InflexionCore.sol:891`), so it is non-circular.
- During routing, an expired/over-band/under-collateralised quote causes
  `_tryQuote`-style logic to *fall back to Path A, never revert*
  (`InflexionCore.sol:692-705`).

### A.4 The WebSocket protocol (MM → relayer)

The WS server is attached to the same HTTP server (`server.ts:216`,
`new WebSocketServer({ server: http })`). The MM streams messages; the relayer replies
per message. Inbound shape:

```json
{ "type": "quote", "quote": <QuoteWire>, "signature": "0x..." }
```

Handling (`server.ts:217-260`):

1. **Parse.** Non-JSON → `{ "type": "error", "error": "invalid json" }` (`:223-225`).
2. **Shape check.** Missing `type:'quote'` / `quote` / `signature` →
   `{ "type": "error", "error": "expected {type:'quote', quote, signature}" }`
   (`:227-232`).
3. **Address check.** `quote.mm` not a valid address →
   `{ "type": "error", "error": "bad mm address" }` (`:234-237`).
4. **Freshness gate** (`freshnessOk`, `server.ts:66-72`): rejects if
   `validUntil ≤ now` (already expired) **or** `validUntil > now + maxValiditySkewS`
   (dated too far out; default `maxValiditySkewS = 60s` — `server.ts:115`). On failure:
   logs the quote as a *loser* and replies
   `{ "type": "rejected", "reason": "stale-or-far-validUntil" }` (`:242-246`).
5. **Signature verify** (`verifyQuote`, EIP-712 recover). On failure: logs as loser,
   replies `{ "type": "rejected", "reason": "bad-signature" }` (`:247-252`).
6. **Accept.** Logs as *winner/candidate*, stores the latest per `(market, MM)`, replies
   `{ "type": "ack", "marketId": "0x...", "loadBps": <n> }` (`:253-257`).

**Reply taxonomy:** `ack` (accepted), `rejected` (freshness or signature failure, with
`reason`), `error` (malformed message). Logging is **best-effort and never blocks the
ack** (`server.ts:238-241`).

**The freshness gate is intentionally non-authoritative** (`server.ts:66`): "the chain
re-checks everything." The relayer's `maxValiditySkewS=60s` is *looser* than the
on-chain `[5,15]s` window; that is deliberate — the relayer's job is only to drop
obvious junk and keep the store clean, while the chain is the real gate.

### A.5 HTTP endpoints (relayer)

CORS is open on every route (`Access-Control-Allow-Origin: *`,
`Allow-Methods: GET, POST, OPTIONS`, `Allow-Headers: content-type`); preflight
`OPTIONS` returns `204` (`server.ts:122-130`). **Why CORS-open:** the browser dApp is a
different origin and must both *read* `GET /quote` (the SDK's `previewPremium`) and
*publish* `POST /quote` (browser-side MM signing) (`server.ts:120-125`).

#### `GET /health` (`server.ts:131-138`)

```json
{ "ok": true,
  "markets": 3,
  "telemetry": { "demand": true, "competition": true } }
```

`markets` = number of markets currently holding ≥1 quote (`store.marketCount()`);
`telemetry.*` reflects whether each sink path is configured.

#### `GET /quote?marketId=0x…` (cheapest live quote) (`server.ts:191-212`)

- `marketId` **must** be a bytes32 hex (`/^0x[0-9a-fA-F]{64}$/`); else `400`
  `{ "error": "marketId (bytes32 hex) required" }` (`:192-195`).
- **Logs the request as latent demand** *before* answering (Signal 4, best-effort,
  never blocks — `:197-199`).
- Looks up `store.best(marketId, now)` = the **cheapest currently-valid** quote
  (lowest `loadBps`, not expired — `store.ts:41-52`).
- No live quote → `404` `{ "error": "no live quote for market", "marketId": "0x…" }`
  (`:201-204`).
- Hit → `200`:

```json
{ "quote": <QuoteWire>,
  "signature": "0x...",
  "loadBps": 500,
  "note": "premium is FairPremium*(1+loadBps), derived on-chain at createSwapRouted" }
```

The `note` (`server.ts:209`) is the canonical reminder that the relayer returns a
*load*, not a dollar premium.

#### `POST /quote` (browser-friendly publish) (`server.ts:157-190`)

Same verify + freshness + store as the WS path, for browser MMs that cannot hold a
persistent socket (`server.ts:156`). Body (read up to **8192 bytes** — `:159`):

```json
{ "quote": <QuoteWire>, "signature": "0x..." }
```

Outcomes:
- bad body → `400 { "error": <reason> }` (`:160-163`).
- missing `quote`/`signature` → `400 { "error": "expected { quote, signature }" }` (`:165-167`).
- bad `mm` → `400 { "error": "bad mm address" }` (`:170-173`).
- stale/far `validUntil` → `422 { "rejected": true, "reason": "stale-or-far-validUntil" }`
  (logs loser — `:174-178`).
- bad signature → `422 { "rejected": true, "reason": "bad-signature" }` (logs loser —
  `:179-184`).
- accepted → `200 { "ok": true, "marketId": "0x…", "loadBps": <n> }` (logs winner,
  stores — `:185-188`).

Note the HTTP path uses `422` for verify/freshness rejections vs the WS path's
`{type:'rejected'}` message; both record the same telemetry reason.

#### `POST /telemetry/preview` (Signal-4 demand ping) (`server.ts:142-154`)

The SDK's `previewPremium` best-effort POST. Body (≤ **4096 bytes** — `:144`) carries
**only bucketed geometry + marketId** (no PII):

```json
{ "marketId": "0x...",
  "widthBucket": "tight",
  "distanceBucket": "at-edge",
  "durationBucket": "week",
  "previewedPremium": "777" }
```

- valid marketId → `202 { "ok": true, "logged": true|false }` — `logged:false` when no
  sink is configured (`telemetry.ts:193-211`).
- missing/invalid marketId → `400 { "ok": false, "reason": "marketId (bytes32 hex)
  required" }` (`telemetry.ts:194-196`).

**Always 202-acks fast and never blocks the preview** — a telemetry failure is reported
as `logged:false`, never an exception (`server.ts:139-141`).

Unmatched routes → `404 { "error": "not found" }` (`server.ts:213`).

### A.6 The day-one telemetry sinks (`packages/engine/src/telemetry.ts`)

**The core WHY (the data moat):** on-chain we *only ever observe realized fills*.
Everything an LP priced but did not buy (**Signal 4 latent demand**) and every MM quote
that lost or was withdrawn (**Signal 2 dynamic half — quote competition**) leaves *no
on-chain trace by design* — invariant **I7**: an unchosen quote touches no
nonce/capacity (`telemetry.ts:1-16`; `docs/ENGINE_TELEMETRY.md:8-13`). If we don't log
it now, it is gone forever. So these two signals must be captured from the very first
interaction, long before any `/data` endpoint, subgraph, or API exists to serve them.

Storage is **append-only JSONL** (one JSON object per line), mirroring the accepted-quote
log in `store.ts`. The writer (`appendJsonl`, `telemetry.ts:107-117`) is **best-effort:
it never throws** — a full disk / bad path / missing sink must not break a quote ack, a
preview, or a `/quote` request. Graceful degradation is a first-class property
(`telemetry.ts:10-16`).

**Privacy-preserving geometry buckets** (`telemetry.ts:20-57`) — the SDK computes these
client-side and POSTs only the labels; the logs hold *no raw geometry, no tokenId, no
addresses*:

- `WidthBucket`: `tight | medium | wide | full | unknown` (tick-span of the LP range).
- `DistanceBucket`: `at-edge | near | mid | deep | unknown` (how near spot is to going
  out of range).
- `DurationBucket`: `hour | day | week | month | longer | unknown` (`expiry − createdAt`).
- Unknown/invalid input coerces to `'unknown'` (`asWidthBucket` etc., `:43-57`).

#### Demand log (Signal 4) — `DEMAND_LOG` → `DemandRecord` (`telemetry.ts:70-82`)

Written on **every `GET /quote` request** and **every `POST /telemetry/preview` ping**.
`filled` is **always `false`** at write time — this log is exactly the demand the chain
never sees (`telemetry.ts:61-69`). Realized fills are reconstructed later from on-chain
`SwapCreated`/`SwapPriced`.

```jsonc
{ "ts": 1900000000,
  "marketId": "0x…",            // bytes32, lowercased
  "widthBucket": "tight",
  "distanceBucket": "at-edge",
  "durationBucket": "week",
  "previewedPremium": "777",    // optional decimal string; absent for a bare /quote
  "filled": false,              // ALWAYS false — the latent/unfilled half
  "source": "preview" }         // "preview" | "quote-request"
```

- `logQuoteRequest(marketId, now)` — emitted by `GET /quote`; buckets are `'unknown'`
  (a bare lookup carries no geometry), `source: 'quote-request'` (`telemetry.ts:175-186`).
- `ingestPreview(input, now)` — emitted by `POST /telemetry/preview`; validates +
  normalizes the loosely-typed body, `source: 'preview'`. `normalizeMarketId` requires
  bytes32 hex (`:138-140`); `normalizePremium` coerces a string/number/bigint into a
  bigint-safe decimal string or drops it (`:143-148`). Returns
  `{ ok, logged, reason? }` (`:193-211`).

#### Competition log (Signal 2) — `COMPETITION_LOG` → `CompetitionRecord` (`telemetry.ts:91-102`)

Written for **every** inbound WS quote — **winners AND losers** (`logQuote`,
`telemetry.ts:218-229`), called from both the WS handler and `POST /quote`. **Why:**
only ever logging the *latest stored* quote (as `store.ts` does) loses the competition —
who else quoted, how wide, who widened/withdrew under stress (`telemetry.ts:84-90`). The
chain only sees the realized fill, so the full competing field is captured only here.

```jsonc
{ "ts": 1900000000,
  "marketId": "0x…",            // bytes32, lowercased
  "mm": "0x…",                  // MM address, lowercased
  "loadBps": 500,
  "validUntil": "1900000010",   // uint64 as decimal string
  "accepted": true,             // true iff stored as a live candidate (verify+freshness passed)
  "reason": "bad-signature" }   // present only when accepted=false (mirrors the WS rejection)
```

`accepted` marks whether the relayer stored it as a candidate (signature + freshness
valid); a *rejected* quote still competed and is still logged (`telemetry.ts:96-99`).

`get demandEnabled` / `get competitionEnabled` (`telemetry.ts:161-169`) report whether
each sink path is configured (surfaced in `/health`).

### A.7 The quote store (`packages/engine/src/store.ts`)

In-memory map `marketId(lc) → mm(lc) → { env, receivedAt }` (`store.ts:16-17`) —
the **latest quote per `(market, MM)`** with an optional append-only JSONL log
(`QUOTE_LOG`).

- `put(env, now)` — store/replace the latest for its `(market, MM)`; if `logPath` set,
  append `{ t, quote, signature }` as JSONL (`store.ts:22-39`).
- `best(marketId, nowSec)` — **the cheapest currently-valid quote** = lowest `loadBps`
  among quotes whose `validUntil > now` (`store.ts:41-52`). This is the *price-to-beat*
  the LP sees; the on-chain router still re-derives everything (`store.ts:1-6`).
- `marketCount()` — number of markets with ≥1 quote (`store.ts:54-57`).

**Scope / not-yet-done** (`README.md:45-53`): single-MM-friendly but multi-MM works
(the store keys per MM); **no auth, no rate-limit, no persistence beyond the JSONL log**;
the definitive Stylus≡Solidity≡off-chain digest cross-check is an integration test
added with the SDK (P4.b).

### A.8 Example MM bot (`packages/engine/src/mm-bot.ts`)

A reference bot that signs a fresh `SignedQuote` on a loop and streams it over WS,
demonstrating the firm-quote / short-TTL model: each quote is GTD
(`validUntil = now + ttl`) and simply re-issued; the MM "cancels" by *not refreshing*
(and the on-chain oracle band voids stale quotes) (`mm-bot.ts:1-7`).

- `TTL_S = 10`, `REISSUE_MS = 5000` (`mm-bot.ts:21-22`) — re-issue every 5s, each valid
  10s, always inside the on-chain `[5,15]s` window.
- Env: `MM_PRIVATE_KEY` (required), `MARKET_ID` (required), `ENGINE_WS`
  (default `ws://localhost:8787`), `CHAIN_ID` (`421614`), `VERIFYING_CONTRACT`,
  `QUOTE_PRICE`, `LOAD_BPS` (default `500` = 5%) (`mm-bot.ts:6-34`).
- Default quote (`mm-bot.ts:39-57`): `minMaxILRatioBps=0`, `maxMaxILRatioBps=10000`
  (accept any MaxIL ratio), `priceBandBps=100` (1%, inside `[25,500]`),
  `model=FULL`, `maxNotionalV0 = 2^128−1` (unbounded capacity), monotonically
  incrementing `nonce`.

### A.9 Engine curl / wscat examples

```bash
# Health (sink status)
curl -s http://localhost:8787/health
# → {"ok":true,"markets":1,"telemetry":{"demand":true,"competition":true}}

# Cheapest live quote for a market (taker side)
curl -s 'http://localhost:8787/quote?marketId=0xb8bbd684f213d5833886ade7b531a6949d85522249881a2b5d46a5cc76e439c2'
# → 200 {"quote":{...},"signature":"0x...","loadBps":500,"note":"premium is FairPremium*(1+loadBps)..."}
# → 404 {"error":"no live quote for market","marketId":"0x..."} when nothing live

# Browser-style MM publish (same path as the WS ack)
curl -s -X POST http://localhost:8787/quote \
  -H 'content-type: application/json' \
  -d '{"quote":{"mm":"0x...","marketId":"0x...","loadBps":500,"minMaxILRatioBps":0,"maxMaxILRatioBps":10000,"quotePrice":"0","priceBandBps":100,"model":0,"partialRatioBps":0,"maxNotionalV0":"340282366920938463463374607431768211455","validUntil":"1900000010","quoteId":"0x...","nonce":"0"},"signature":"0x..."}'
# → 200 {"ok":true,"marketId":"0x...","loadBps":500}

# Day-one demand ping (SDK previewPremium; buckets only, no PII)
curl -s -X POST http://localhost:8787/telemetry/preview \
  -H 'content-type: application/json' \
  -d '{"marketId":"0x...","widthBucket":"tight","distanceBucket":"at-edge","durationBucket":"week","previewedPremium":"777"}'
# → 202 {"ok":true,"logged":true}

# WS stream (MM): connect ws://localhost:8787 and send
#   {"type":"quote","quote":<QuoteWire>,"signature":"0x..."}
# ← {"type":"ack","marketId":"0x...","loadBps":500}
#   or {"type":"rejected","reason":"stale-or-far-validUntil"|"bad-signature"}
#   or {"type":"error","error":"invalid json"|"bad mm address"|...}
```

---

## Part B — The Public REST API (`@inflexion/api`)

### B.0 What it is, and the three-layer rule

A **public, read-only, cached** facade — *no wallet, no signer, no RPC key for
consumers* (`packages/api/src/index.ts:1-16`; `app.ts:53` "read-only";
`server.ts:13-14`). Framework-free `node:http`, matching the engine's style and keeping
it offline-test-friendly (`app.ts:1-7`). It composes **three backings**, each degrading
independently:

> **The routing rule** (`docs/ACCESS_LAYER_ARCHITECTURE.md` §1, quoted in
> `README.md:8-12`): *needs history or an aggregate → subgraph (consumed via this API);
> needs frictionless public access with no wallet and no RPC key → this API.*

1. **Subgraph-backed** (history/aggregate): runs a GraphQL query. The subgraph is **not
   deployed yet**, so today these return a typed `pending` body **with the exact query
   embedded** (`handlers.ts:6-12`, `:43-51`).
2. **Live RPC**: reuses `@inflexion/sdk` `DataClient.getCurrentLoadSurface` /
   `DepositorClient.getVaultState` — **the SDK owns pricing; the API never re-derives
   the fair rate / load stack** (`handlers.ts:9-12`; `README.md:14-18`). This is a
   *hard rule*: the Φ-sum fair rate is computed in exactly one place (the Stylus
   `FairValueOracle`), surfaced through the SDK; the API only *forwards* it
   (`handlers.ts:134-137`).
3. **Telemetry**: reads the engine's JSONL sinks (`DEMAND_LOG`, `COMPETITION_LOG`) for
   the dynamic moat halves (`handlers.ts:10-12`; `src/telemetry.ts:1-12`). The API
   reads these **files**, not a subgraph entity or contract event — putting unfilled
   interest on-chain would break I7 and cost gas (`src/telemetry.ts:8-11`).

### B.1 Entry point + environment (`packages/api/src/server.ts`)

| Env var                | Default | Effect when absent |
| ---------------------- | ------- | ------------------ |
| `PORT`                 | `8088`  | — (`server.ts:20`) |
| `SUBGRAPH_URL`         | unset   | subgraph surfaces return `pending` (`server.ts:22`, `:8`) |
| `ARBITRUM_SEPOLIA_RPC` | unset   | live endpoints return `pending` (`server.ts:23`, `:9`) |
| `SEPOLIA_RPC`          | unset   | fallback RPC alias (`server.ts:23`) |
| `DEMAND_LOG`           | unset   | Signal-4 latent half `pending` (read-only — `server.ts:24`) |
| `COMPETITION_LOG`      | unset   | Signal-2 dynamic half `pending` (read-only — `server.ts:25`) |

`buildDeps` (`index.ts:60-96`) wires env → deps. The live SDK clients (`DataClient` +
`DepositorClient`) are constructed **only when an RPC url is supplied**, sharing one
public client (`index.ts:81-87`). **Why:** with no RPC the live endpoints *honestly*
report `rpc-unavailable` instead of silently hitting a default public node
(`index.ts:54-59`, `:77-80`). The whole stack is fully testable **offline** — mock
subgraph, injected fetch, injected telemetry reader, pre-built SDK clients
(`index.ts:32-52`; `handlers.ts:3-7`). Startup logs which backings are live
(`server.ts:35-42`).

### B.2 The response envelope: `available:true` vs typed `pending`

**Every data endpoint returns one of two shapes, and never throws**
(`types.ts:1-8`, `:32-33`; OpenAPI `ApiResult` `openapi.ts:256-262`):

```jsonc
// Available
{ "available": true, ...payload }

// Pending (typed degraded)
{ "available": false,
  "reason": <PendingReason>,
  "detail": "human note describing what unblocks this surface",
  "query": "<the future GraphQL query this surface WILL run>" }   // present for subgraph routes
```

**`PendingReason`** is a closed enum (`types.ts:11-16`; OpenAPI `:236-245`):

| Reason                     | When |
| -------------------------- | ---- |
| `subgraph-not-deployed`    | no `SUBGRAPH_URL` configured (the default state today) |
| `subgraph-unreachable`     | configured but HTTP/network/timeout failure |
| `rich-events-pre-redeploy` | subgraph deployed-but-quiet: `SwapPriced`/`QuoteFilled` not yet firing |
| `telemetry-sink-absent`    | `COMPETITION_LOG`/`DEMAND_LOG` not configured on the engine |
| `rpc-unavailable`          | no RPC wired, or a live RPC read failed |

`subgraphPending(reason, detail, query)` maps the subgraph outcome to a `Pending` and
**embeds the exact query** that surface will run at the redeploy (`handlers.ts:43-51`).
**Why embed the query:** the surface is self-documenting and wired-and-ready — a
consumer (or judge) can see precisely what data will appear, and the redeploy is a flip,
not a rewrite (`types.ts:18-19`; `queries.ts:1-7`).

**Three standing disclosures** are attached to the relevant surfaces (`types.ts:35-49`):

- **Claim A** (`CLAIM_A_DISCLOSURE`, every *payout/swap/MM* surface):
  *"LPs are always paid with no bad debt in FULL mode — qualified: capped payoff +
  solvent USDC + oracle/settlement liveness."* Note the **qualifying clause** is always
  present (never state no-bad-debt unqualified).
- **Claim B** (`CLAIM_B_DISCLOSURE`, every *NAV/yield/pool* surface):
  *"Depositor capital is NOT guaranteed: the junior tranche is first-loss; the senior
  tranche is structurally protected from underwriting loss only, not systemic tail."*
- **Maturity disclaimer** (`MATURITY_DISCLAIMER`, every *moat-signal* surface):
  structures ship day one, dynamics mature with multiple competing MMs + volume; the
  dataset begins at the single redeploy; the off-chain telemetry halves begin at the
  first logged interaction.

The two depositor claims are **never merged** — `/pool` is a claim-B surface,
`/swaps`/`/mm` are claim-A surfaces (`handlers.ts:105-108`).

### B.3 Cross-cutting behavior (`app.ts`)

- **GET-only.** Non-GET → `405 { available:false, reason:'method-not-allowed',
  detail:'read-only API; GET only' }` (`app.ts:124-131`). `OPTIONS` → `204` with CORS
  (`app.ts:115-123`).
- **CORS open** on every JSON response (`access-control-allow-origin: *`,
  `app.ts:58-66`); HTML routes too (`:68-75`).
- **bigint-safe wire format.** `JSON.stringify` uses a replacer that coerces every
  `bigint` → decimal string (`jsonReplacer`, `app.ts:53-56`).
- **Caching.** JSON responses send `Cache-Control: public, max-age=5` (`app.ts:62`);
  HTML (`/docs`) sends `max-age=300` (`app.ts:72`). Internally a per-route TTL cache
  (`TtlCache`, `cache.ts`) memoises producers; **errors are NOT cached**
  (`cache.ts:32-39`). Per-route TTLs (`cache.ts:46-66`, from
  `ACCESS_LAYER_ARCHITECTURE.md §7.1`): markets 60s, marketById 5s, pricingPreview 3s,
  poolState 5s, navHistory 60s, swapById 5s, loadSurface 60s, convexitySurface 300s,
  netGamma 60s, sigmaHistory 60s, mmFills 30s, etc.
- **Last-resort 500 guard.** Handlers never throw by design; a stray bug returns
  `500 { available:false, reason:'internal', detail }` rather than crashing the process
  (`app.ts:104-111`).
- **Unmatched route** → `404 { available:false, reason:'not-found', detail:'no route
  for <path>' }` (`app.ts:291`).

### B.4 Endpoint reference (path · query · backing · returns)

Backing key: **[SG]** subgraph (pending today), **[RPC]** live via SDK over RPC,
**[TEL]** engine telemetry sink, **[STATIC]** served unconditionally. Routes mirror
`app.ts` and `openapi.ts` exactly.

#### System / docs

| Path | Backing | Returns |
| ---- | ------- | ------- |
| `GET /health` | [STATIC] | `{ ok, subgraph, live, telemetry:{demand,competition} }` — `subgraph`=URL configured, `live`=RPC wired, `telemetry.*`=sink configured (`app.ts:137-149`; schema `openapi.ts:263-278`) |
| `GET /openapi.json` | [STATIC] | the OpenAPI 3.1 document, verbatim (`app.ts:152-155`; `openapi.ts:14`) |
| `GET /docs` (or `/docs/`) | [STATIC] | Swagger-UI HTML shell rendering `/openapi.json` from a CDN (`app.ts:156-159`; `openapi.ts:300-318`) |

The OpenAPI doc is **hand-authored** (no codegen, no network), so it stays
offline-CI-safe and is the single source of truth for the endpoint contract; it models
the `available`/`pending` discriminated union once and `$ref`s it everywhere
(`openapi.ts:1-12`, `:256-262`).

#### Markets directory — [SG]

| Path | Query | Returns |
| ---- | ----- | ------- |
| `GET /markets` | — | `{ markets:[...] }` (`getMarkets`, `handlers.ts:55-61`; query `Q_MARKETS` `queries.ts:169-189`) |
| `GET /markets/:id` | path `id` = bytes32 | `{ market }` (`getMarketById`, `handlers.ts:63-74`; `Q_MARKET_BY_ID` `queries.ts:191-210`) — route regex `app.ts:166-170` |

Market fields include `token0/token1/fee`, `durationSeconds/durationBucket`,
`oracleToken`, `active`, `cvammEnabled`, and rollups `totalSwaps/totalSettled/totalV0/
totalPremium/totalPayout/pathBFills` (`queries.ts:172-188`).

#### Pool / vault — claim B

| Path | Query | Backing | Returns |
| ---- | ----- | ------- | ------- |
| `GET /pool` | `marketIds` (CSV bytes32, optional) | **[RPC]** | LIVE vault-state composite via SDK `getVaultState` (NAV, senior/junior assets, util, conc, the two skews, regime) + `CLAIM_B_DISCLOSURE`. No `depositor` client ⇒ `rpc-unavailable`; SDK degrade surfaced as-is (`getPoolState`, `handlers.ts:109-132`; route `app.ts:173-176`) |
| `GET /pool/load-surface` | `marketIds` (CSV bytes32) | **[RPC]** | LIVE current pool-load surface via SDK multicall (the *price-to-beat*) + `MATURITY_DISCLAIMER` (`getCurrentLoadSurface`, `handlers.ts:80-103`; route `app.ts:179-182`). Works **now**, pre-redeploy — reads public getters, not rich events (`handlers.ts:76-78`) |
| `GET /pool/nav-history` | `bucket=day\|hour` (default `day`) | **[SG]** | per-tranche NAV time series + `CLAIM_B_DISCLOSURE` (`getNavHistory`, `handlers.ts:314-325`; `Q_POOL_DAY/HOUR_SNAPSHOTS` `queries.ts:237-271`; route `app.ts:185-189`) |

#### Pricing — [RPC], claim implicit

| Path | Query | Returns |
| ---- | ----- | ------- |
| `GET /pricing/preview` | `marketId` (**required**, bytes32), `a`, `b`, `maxIL` (raw bigints, optional) | LIVE cached `{ pricing:<row>, note }` from the SDK current-load surface. `marketId` invalid → `400 { available:false, reason:'bad-request', detail:'marketId (bytes32 hex) required' }`. The geometry override is applied **only when all three of `a`,`b`,`maxIL` are supplied** (a partial geometry is ambiguous → SDK neutral reference); `a=(Pa/P0)²` WAD, `b=(Pb/P0)²` WAD (`getPricingPreview`, `handlers.ts:139-188`; route `app.ts:192-216`) |

The API **never re-derives the fair rate** — it forwards the SDK row, which already
carries `fairPremium` + `poolPremium` (`handlers.ts:134-137`, `:177-182`).

#### Swaps — [SG], claim A

| Path | Query | Returns |
| ---- | ----- | ------- |
| `GET /swaps` | `status=active\|settled`, `mm` (addr), `market` (bytes32), `first` (1–1000, default 100) | `{ swaps:[...] }` + `CLAIM_A_DISCLOSURE`. The GraphQL `where` is built **handler-side from validated filters**, never user-injected: `status=active→isActive:true`, `status=settled→status:'SETTLED'`, `mm`/`market` lowercased (`getSwaps`, `handlers.ts:347-377`; `Q_SWAPS` `queries.ts:320-346`; route `app.ts:259-275`) |
| `GET /swaps/:swapId` | path `swapId` = decimal | `{ swap }` + `CLAIM_A_DISCLOSURE` (`getSwapById`, `handlers.ts:381-390`; `Q_SWAP_BY_ID` `queries.ts:349-380`; route `app.ts:278-282`) |

Swap rows carry the full economics: `v0`, `maxIL`, `premium`, `path`, `mmLoadBps`,
`cappedAtMaxIL`, `realisedIL`, `payout`, `pnlForMm`, `settlementPrice`, etc.
(`queries.ts:324-345`, `:351-379`).

#### The five moat signals — `/data/*`

The signal taxonomy (`app.ts:18-25`; `queries.ts:8-16`;
`ACCESS_LAYER_ARCHITECTURE.md §5`):

| Path | Signal | Backing | Returns |
| ---- | ------ | ------- | ------- |
| `GET /data/load-surface?marketId` | 1 (historical clearing-load) | **[SG]** | `{ snapshots:[...] }` + maturity (`getLoadSurfaceHistory`, `handlers.ts:192-206`; `Q_MARKET_STATE` `queries.ts:212-234`) |
| `GET /data/convexity-surface` | 1 + 2 structural | **[SG]** | `{ buckets:[...] }` — clearing-load over σ_ref + pool-vs-MM spread, bucketed width×distance×duration, **EXCLUDING cap-bound fills** + maturity (`getConvexitySurface`, `handlers.ts:210-223`; `Q_BUCKET_AGGREGATES` `queries.ts:23-43`) |
| `GET /data/term-structure?width&distance` | 3 (convexity term structure) | **[SG]** | `{ points:[...] }` across 7/30/90d per range + maturity; defaults `width=medium`, `distance=mid` (`getTermStructure`, `handlers.ts:227-240`; `Q_TERM_STRUCTURE` `queries.ts:78-96`; route `app.ts:228-233`) |
| `GET /data/demand-requests?marketId&since` | 4 (demand skew) | **[SG]+[TEL]** | `{ realized:<subgraph or pending>, latent:[aggregated TEL], latentEnabled, disclosure }` — *both halves with separate availability* (`getDemandRequests`, `handlers.ts:244-266`) |
| `GET /data/quote-competition?marketId&since` | 2 (dynamic half) | **[TEL]** | `{ competition:[aggregated], enabled, disclosure }`; sink absent → `pending('telemetry-sink-absent', …)` (`getQuoteCompetition`, `handlers.ts:270-282`) |
| `GET /data/net-gamma` | 5 (net gamma) | **[SG]** | `{ snapshots, protocolState }` + maturity (`getNetGamma`, `handlers.ts:286-300`; `Q_NET_GAMMA` `queries.ts:148-166`) |
| `GET /data/supply-depth` | 5 (raw active set) | **[SG]** | `{ activeSwaps:[...] }` — the `isActive` open set + maturity (`getSupplyDepth`, `handlers.ts:302-310`; `Q_ACTIVE_SWAPS` `queries.ts:119-146`) |

`marketId`/`since` filters are parsed by `parseFilter` (`app.ts:294-302`); `marketId`
must be bytes32, `since` a unix-ts integer.

**Signal 4 is the only intrinsically split surface.** `/data/demand-requests` returns
the *realized* half from the subgraph (`pending` today) **and** the *latent* half from
the engine `DEMAND_LOG` (LIVE now), each carrying its own availability flag — so the
demand surface is partially live before the redeploy (`handlers.ts:244-266`).

#### MM + sigma — [SG]

| Path | Query | Returns |
| ---- | ----- | ------- |
| `GET /mm/:address/fills` | path `address` = 0x…40 | `{ marketMaker, swaps:[...] }` + `CLAIM_A_DISCLOSURE` (`getMmFills`, `handlers.ts:329-345`; `Q_MARKET_MAKER` `queries.ts:274-301`; route `app.ts:252-256`) |
| `GET /sigma/:token/history` | path `token` = 0x…40 | `{ points:[...] }` σ_ref history incl. `SwapPriced` backfill points (`getSigmaHistory`, `handlers.ts:394-405`; `Q_SIGMA_HISTORY` `queries.ts:383-397`; route `app.ts:285-289`) |

### B.5 The subgraph client (`packages/api/src/subgraph.ts`)

Designed for **graceful degradation** — with no `url` (or an unreachable endpoint),
every call returns a typed degraded result; **the request never throws** (`subgraph.ts:1-9`).

- `configured` getter — true iff a non-empty URL is set (does *not* prove reachability —
  `subgraph.ts:35-38`).
- `query<T>(query, variables)` → `SubgraphOutcome<T>` =
  `{ok:true, data}` | `{ok:false, reason, detail}` where `reason ∈
  {'not-configured','unreachable','graphql-error'}` (`subgraph.ts:20-22`, `:44-91`).
  - no url → `not-configured` (`:48-54`); no fetch impl → `unreachable` (`:55-58`).
  - HTTP non-2xx → `unreachable` with `subgraph HTTP <status>` (`:69-71`).
  - GraphQL `errors[]` → `graphql-error` joining messages (`:72-79`); `data` missing →
    `graphql-error` (`:80-82`).
  - network/abort → `unreachable` (`:84-86`).
- 8s default timeout via `AbortController` (`subgraph.ts:32`, `:60-61`).
- `fetchImpl` is injectable so tests stay offline (`subgraph.ts:14-17`, `:30-31`).

The handler maps `not-configured`→`subgraph-not-deployed` and
`unreachable`/`graphql-error`→`subgraph-unreachable` for the public envelope
(`handlers.ts:43-51`).

### B.6 The telemetry reader (`packages/api/src/telemetry.ts`)

Reads the engine's JSONL sinks and serves aggregated views; mirrors the engine's
`DemandRecord`/`CompetitionRecord` shapes (`src/telemetry.ts:14-35`). **Reads degrade
gracefully:** an absent/unreadable sink yields `[]` (and the handler emits `pending`);
the reader never throws (`src/telemetry.ts:9-12`, `:47-59`). The file reader is
injectable for offline tests (`JsonlReader`, `:37-45`). A malformed JSONL line is
skipped — a partial last write must not break the read (`parseJsonl`, `:61-74`).

- `demandSurface(opts)` → `DemandBucketAgg[]` aggregated by
  `(market × width × distance × duration)`: `{count, previews, quoteRequests, firstSeen,
  lastSeen}`, sorted by `count` desc (`:135-162`).
- `competitionSurface(opts)` → `CompetitionAgg[]` aggregated per `(market × MM)`:
  `{quotes, accepted, rejected, minLoadBps, maxLoadBps, avgLoadBps, lastSeen}`, sorted
  by `quotes` desc (`:179-214`).
- Both accept `{ marketId?, since? }` filters (`:121-133`, `:165-177`).

### B.7 The GraphQL query catalogue (`packages/api/src/queries.ts`)

The query *shapes* are wired-and-ready and live here (not inline) so they are testable
and self-documenting; today the handlers embed them in the `pending` body
(`queries.ts:1-7`). Signal mapping (`queries.ts:8-16`):

- **Signal 1 + 2 structural** — `Q_BUCKET_AGGREGATES` (`:23-43`): clearing load over
  σ_ref, **excludes cap-bound fills by construction** (the `BucketAggregate` accumulates
  non-capped fills only — `:18-22`). `Q_BUCKET_FILLS` (`:48-73`) gives per-fill rows for
  an exact median (the subgraph store has no median operator — `:18-22`).
- **Signal 3** — `Q_TERM_STRUCTURE` (`:78-96`): the 7/30/90d rows of one
  `(width, distance)`; the **slope of `medianMMLoadBps` across `durationBucket` IS the
  signal** (Path B behavioral; Path A is duration-flat — `:75-77`).
- **Signal 4 realized** — `Q_GEOMETRY_DEMAND` (`:101-114`); the latent half is OFF-CHAIN
  telemetry, *not* this query (`:98-100`).
- **Signal 5** — `Q_ACTIVE_SWAPS` (`:119-146`) + `Q_NET_GAMMA` snapshots (`:148-166`):
  the active set the API sums off-chain Greeks over (finite-difference the deployed
  ILMath / FairValueOracle — `:116-118`).
- Directory/pool/MM/swap/sigma queries `:169-397`. All keyed in `QUERIES`
  (`:400-417`).

### B.8 API curl examples

```bash
# Health — which backings are live right now
curl -s http://localhost:8088/health
# → {"ok":true,"subgraph":false,"live":true,"telemetry":{"demand":true,"competition":true}}

# OpenAPI doc + interactive docs
curl -s http://localhost:8088/openapi.json
#   open http://localhost:8088/docs in a browser

# LIVE pool-load surface (price-to-beat) — works NOW, no subgraph
curl -s 'http://localhost:8088/pool/load-surface?marketIds=0x67c4bee1ee037851fbe2a8ecfdd0b8ae3d358283e940750c268621f776479d69'
# → {"available":true,"surface":{...},"note":"LIVE uncached pool-load surface...","disclosure":"Structures ship..."}

# LIVE pricing preview with explicit geometry (a,b,maxIL all required for the override)
curl -s 'http://localhost:8088/pricing/preview?marketId=0x67c4...d69&a=...&b=...&maxIL=1669240000'
# → {"available":true,"pricing":{...,"fairPremium":...,"poolPremium":...},"note":"LIVE cached fair + pool premium..."}

# LIVE pool vault state (claim B) — SDK getVaultState
curl -s http://localhost:8088/pool
# → {"available":true,"pool":{...NAV, senior/junior, util, conc, skews, regime...},"disclosure":"Depositor capital is NOT guaranteed..."}

# Signal 4 — demand requests: latent half LIVE, realized half pending
curl -s http://localhost:8088/data/demand-requests
# → {"available":true,"realized":{"available":false,"reason":"subgraph-not-deployed","query":"..."},
#    "latent":[{"marketId":"0x...","widthBucket":"tight",...,"count":3,"previews":2,"quoteRequests":1}],
#    "latentEnabled":true,"disclosure":"Structures ship..."}

# Signal 2 dynamic — quote competition from COMPETITION_LOG (winners AND losers)
curl -s 'http://localhost:8088/data/quote-competition?marketId=0x...&since=1900000000'
# → {"available":true,"competition":[{"mm":"0x...","quotes":12,"accepted":10,"rejected":2,"minLoadBps":480,"avgLoadBps":510,...}],"enabled":true,...}
# sink absent → {"available":false,"reason":"telemetry-sink-absent","detail":"COMPETITION_LOG not configured..."}

# Subgraph-backed surface today — typed pending WITH the embedded query
curl -s http://localhost:8088/markets
# → {"available":false,"reason":"subgraph-not-deployed",
#    "detail":"no subgraph url configured (not deployed yet)",
#    "query":"query Markets($first: Int = 100) { markets(...) { id token0 token1 fee ... } }"}

# Swaps (claim A) with filters
curl -s 'http://localhost:8088/swaps?status=active&first=50'
# → pending today; will return {"available":true,"swaps":[...],"disclosure":"LPs are always paid... qualified..."}
```

---

## Part C — How the two services + the chain fit together (end-to-end)

1. **MM streams a firm quote** to the engine over WS (`{type:'quote', quote, signature}`).
   The relayer verifies EIP-712 + freshness, stores it as the cheapest-per-market
   candidate, logs it to `COMPETITION_LOG` (winner) — `server.ts:217-260`.
2. **LP previews** via the SDK `previewPremium`: the SDK reads the *live* pool-load
   surface (via RPC or the API `/pool/load-surface`) and `GET /quote` (the cheapest MM
   load), then best-effort POSTs `/telemetry/preview` (logged to `DEMAND_LOG`) —
   `server.ts:139-154`, `telemetry.ts:188-211`.
3. **LP buys** by calling `createSwapRouted` on `InflexionCore` **on-chain**. The chain
   re-derives `FairPremium` (Φ-sum from the Stylus `FairValueOracle`), re-checks the
   quote's validity window `[5,15]s`, the price band (I9), the nonce (I7), and routes
   to the **cheaper of {cvAMM pool, MM quote}**; an invalid quote falls back to Path A,
   never reverts (`InflexionCore.sol:692-705`, `:875-894`).
4. **Settlement** pays the LP `min(realized_IL, MaxIL)` trustlessly from the chosen
   underwriter's collateral. The 2026-06-05 lifecycle demonstrated both: Path A
   (cvAMM, swap #1, premium $9.70 = 0.58% of MaxIL, payout $148.64) and Path B (MM beat
   the pool, swap #2, MM load 1000 bps, payout $245.66 from MM collateral) —
   `deployments/arbitrum-sepolia.json:77-106`.
5. **The API exposes the microstructure**: live surfaces now (RPC), telemetry halves now
   (JSONL), the rest *pending-with-embedded-query* until the subgraph deploys at the
   single redeploy — at which point `SwapPriced`/`QuoteFilled` join the structural moat
   halves to the dynamic halves already captured.

---

## Part D — Known status / caveats (for honest judge answers)

- **Subgraph not yet deployed** ⇒ all `[SG]` surfaces return
  `{available:false, reason:'subgraph-not-deployed', query:…}` today. This is the
  *typed pending* state by design, not a failure (`types.ts:1-8`; `README.md:20-32`).
  `_deployBlock = 274081134` is the subgraph `startBlock` — the moat dataset begins
  there (`deployments/arbitrum-sepolia.json:41`).
- **Engine scope:** no auth, no rate-limit, no persistence beyond JSONL; the definitive
  Stylus≡Solidity≡off-chain digest cross-check is a P4.b integration test
  (`README.md:45-53`).
- **`/quote` returns a load, not a dollar premium** — the dollar premium is
  position-specific and computed on-chain (`README.md:46-49`; `server.ts:8-11`).
- **No-bad-debt is always stated WITH its qualifying clause** in the API
  (`CLAIM_A_DISCLOSURE`, `types.ts:41-43`): FULL + capped payoff + solvent USDC +
  oracle/settlement liveness.
- **`docs/API.md` is a stub** (`docs/API.md:1-9`) — the live contract is the
  `/openapi.json` document + this KB, not that file.
