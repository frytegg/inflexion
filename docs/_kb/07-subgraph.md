# 07 — The Subgraph (`@inflexion/subgraph`)

> Source of truth for this doc: `packages/subgraph/{schema.graphql, subgraph.yaml,
> src/*, scripts/gen-manifest.mjs}` + `deployments/arbitrum-sepolia.json`. Every
> technical claim below cites `file:line`. Where a value is uncertain or
> forward-looking it is flagged explicitly.

---

## 0. What the subgraph is (and is NOT)

The subgraph is **The Graph indexer** that reconstructs Inflexion's on-chain
**event history** into a **queryable GraphQL store** which feeds the public REST
API (`@inflexion/api`). It is the durable, deterministic memory of the protocol:
it replays the contract event log from a fixed start block and materialises it
into entities the API reads cheaply.

- It is **internal infrastructure**. In production *nobody queries it directly
  except the API* — the API is the public surface; the subgraph is the indexer
  behind it (`packages/subgraph/README.md:1-9`).
- Its reason to exist is **the data moat**: the first public view into the
  microstructure of the DeFi LP volatility-risk premium. The schema is
  explicitly mapped to the **five data-moat signals**
  (`schema.graphql:2-16`, `README.md:6-9`).
- Every signal is reconstructable two ways: as a **current snapshot** (the latest
  aggregate row) AND as a **historical series** (per-fill `Swap` rows +
  time-bucketed snapshots) (`schema.graphql:4-5`).

### The honest-framing rules baked into the schema (why it is non-circular)

These are design constraints written into the schema header
(`schema.graphql:7-16`) — they are *load-bearing for the data moat's credibility*:

1. **No `impliedVol` field anywhere.** Inverting `fairRate` to back out an
   implied vol is *circular* (the fair rate was computed *from* σ_ref in the first
   place), so it was deliberately dropped (`schema.graphql:8`).
2. **The MM `loadBps` (Path B) is the single NON-CIRCULAR load datum.** It is an
   *actor's chosen* price of risk, not a mechanical function of inputs. The pool
   `totalLoadWad` (Path A) is the **mechanical baseline / price-to-beat**
   (`schema.graphql:9-11`).
3. **Cap-bound fills carry ZERO load information and are excluded** from the load
   aggregates (Signals 1/2/3). A fill where `cappedAtMaxIL == true` priced against
   the cap, not against the risk, so it would poison a load mean
   (`schema.graphql:11-12`, enforced at `inflexion-core.ts:326`).
4. **The dynamic halves of Signals 2 & 4** (live quote competition, latent
   unfilled demand) are **off-chain engine telemetry served by the API — NOT
   subgraph entities** (`schema.graphql:13-14`). The subgraph only owns the
   *realized, on-chain* halves.
5. **Signal 5 net-gamma Greeks are off-chain compute** over the active-swap set
   the subgraph tracks (`Swap.isActive`); the Greeks fields on `NetGammaSnapshot`
   are **written back by the API**, not by the indexer (`schema.graphql:15-16`).

The recurring pattern: **the subgraph indexes the canonical structural facts;
the API joins them with off-chain telemetry and back-fills derived/Greeks
fields.** Several entity fields are intentionally left `null` for the API to fill
(documented per-field below).

---

## 1. Data sources & manifest (`subgraph.yaml`)

`specVersion: 0.0.5`, `apiVersion: 0.0.7`, `language: wasm/assemblyscript`
(`subgraph.yaml:9,23,24`). Network: `arbitrum-sepolia` (chainId **421614**).

Three Ethereum data sources, **all starting at the same block 274081134**
(`subgraph.yaml:20,74,111`):

| Data source | Address | Mapping file | Entities owned |
|---|---|---|---|
| **InflexionCore** | `0xc19865cf8403f59b8eca835833afee3aa8da4848` | `src/inflexion-core.ts` | Market, Swap, BucketAggregate, GeometryDemandBucket, NetGammaSnapshot, ProtocolState, MarketMaker, MarketStateSnapshot, SigmaPoint, Nonce (`subgraph.yaml:14-36`) |
| **ConvexityVault** | `0xde2ffeba2e6a18f3a53d43ec0fccd299158ec30d` | `src/convexity-vault.ts` | Depositor, PoolState, PoolDaySnapshot, PoolHourSnapshot, Market, MarketStateSnapshot (`subgraph.yaml:69-87`) |
| **VolOracle** | `0xfdeafbb381192fc5337499d041eaead04d565ed9` | `src/vol-oracle.ts` | SigmaPoint (`subgraph.yaml:106-119`) |

These three addresses match the live registry exactly:
`inflexionCore`, `convexityVault`, `volOracle` in
`deployments/arbitrum-sepolia.json:49,55,51`.

### Enrichment eth_calls (the subgraph reads chain state, not just events)

Two events carry too little data on their own, so the mapping does an
**`eth_call` enrichment** (the canonical Graph pattern — bind the contract, use
`try_*` so a revert degrades gracefully instead of failing the handler):

- **`SwapCreated`** → `NonfungiblePositionManager.positions(tokenId)` to decode
  range geometry (`tickLower/tickUpper/liquidity/token0/token1/fee`)
  (`inflexion-core.ts:157-170`), AND `InflexionCore.swaps(swapId)` to recover
  `expiry`/`createdAt` → `durationSeconds` (`inflexion-core.ts:178-192`). This is
  why `NonfungiblePositionManager` is a second ABI on the InflexionCore source
  (`subgraph.yaml:40-41`).
- **`CollateralLocked`** → `ConvexityVault.lockedByMarket(marketId)` for the exact
  per-market locked, plus `utilizationWad()` / `concentrationWad()`
  (`convexity-vault.ts:239-248`).

The **NPM address is never hardcoded.** It is templated from the registry's
`uniswap.nonfungiblePositionManager` into `src/generated-addresses.ts`
(`generated-addresses.ts:8` = `0x6b2937bde17889edcf8fbd8de31c3c2a70bc4d65`, matching
`deployments/arbitrum-sepolia.json:25`). The AS mapping cannot read the JSON at
runtime, so the codegen step bakes it in (`gen-manifest.mjs:39-42,185-196`).

### ABIs are local & minimal (offline-safe codegen)

`abis/*.json` are **hand-written minimal ABIs** — events + the `swaps` getter +
NPM `positions` — so `graph codegen` runs fully offline with no network fetch
(`README.md:50-52`). This is what keeps CI green without a chain connection.

---

## 2. The deploy story (start block, build, pending state)

`subgraph.yaml` is **auto-generated — never hand-edited** (banner at
`subgraph.yaml:1`, `gen-manifest.mjs:1-21`). It is templated from
`deployments/arbitrum-sepolia.json`, the **single address registry** (the same
registry the SDK's `addresses.ts` consumes) (`gen-manifest.mjs:3-5`).

- **`startBlock = 274081134`** on all three sources (`subgraph.yaml:20,74,111`).
  This is the **redeploy block** (`_deployBlock` in
  `deployments/arbitrum-sepolia.json:40`), set as the start block via env:
  `SUBGRAPH_START_BLOCK=<deployBlock> pnpm prepare:manifest`
  (`gen-manifest.mjs:13`, `subgraph.yaml:8`). **The moat dataset BEGINS there.**
- **Why the redeploy is the genesis:** the rich moat events (`QuoteFilled`,
  `SwapPriced`) are *coded but did not fire* before the FULL-FRESH redeploy of
  2026-06-05. Pre-redeploy their handlers are simply idle / never invoked; the
  entities exist and are ready (`gen-manifest.mjs:6-11`, `subgraph.yaml:3-6`,
  `README.md:28-32,47`). Indexing from the redeploy block means no wasted scan
  over blocks that emit none of the moat data.
- **The committed default start block is `0`** (index from genesis — safe but
  slow). CI only runs `graph codegen`, which validates schema + ABIs + mappings
  *offline* and needs no real start block. The home PC plugs in the redeploy
  block for the full build/deploy (`gen-manifest.mjs:15-18`).

### Build / deploy scripts (`package.json:6-15`)

| Script | Command | Network? |
|---|---|---|
| `prepare:manifest` | `node scripts/gen-manifest.mjs` (regenerate `subgraph.yaml` + `generated-addresses.ts`) | No |
| `codegen` / `build` | `graph codegen` — typegen from schema + ABIs (offline; this is why `build` is *just* codegen, so `pnpm -r build` stays green offline) | No |
| `build:wasm` | `graph codegen && graph build` — full AssemblyScript → WASM compile | Yes (downloads `asc`) |
| `deploy` | `graph deploy --node https://api.studio.thegraph.com/deploy/ inflexion-arb-sepolia` | Yes (IPFS) |
| `deploy:local` / `create:local` | local Graph node at `:8020` / IPFS `:5001` | local |

There is deliberately **no `test` script**, so `pnpm -r test` does not invoke
matchstick (which would need a toolchain download) (`README.md:21-23`).

### Pending status (current state, 2026-06)

The Studio deploy is **pending until the Studio slug is created**. The target
slug is `inflexion-arb-sepolia` (`package.json:13`). Until the deploy lands, the
API's history surfaces degrade to a **typed pending state** rather than erroring —
the schema + manifest are finalised and the redeploy block is known, so the
indexer is ready to go the moment the slug exists.

---

## 3. The `marketId` derivation (tight-packed keccak parity)

`marketId` is the join key that ties subgraph ⇄ SDK ⇄ on-chain contract together,
so its byte layout is **load-bearing**.

```
marketId = keccak256(abi.encodePacked(token0, token1, fee, durationSeconds))
```

- On-chain it is `keccak256(abi.encodePacked(address token0, address token1,
  uint24 fee, uint32 durationSeconds))` — confirmed in `InflexionCore.sol` at
  `registerMarket` L355, `_prepareSwap` L590, `_marketForSwap` L1146,
  `_marketIdForSwap` L1157 (cited in `helpers.ts:128-151`; verified directly in
  the contract).
- `abi.encodePacked` is **TIGHT packing — no 32-byte ABI padding** — so the
  preimage is exactly **20 + 20 + 3 + 4 = 47 bytes** (`helpers.ts:134-141`).
- The subgraph replicates it in `deriveMarketId` (`helpers.ts:153-164`):
  concatenate the raw big-endian bytes of each field at its on-chain width —
  address → 20 bytes (Address is already a 20-byte `ByteArray`), `uint24 fee` →
  3 big-endian bytes, `uint32 durationSeconds` → 4 big-endian bytes — then
  `crypto.keccak256`. It uses a hand-rolled `uintBytesBE` (`helpers.ts:117-125`),
  **NOT `ethereum.encode`**, because `ethereum.encode` ABI-pads every operand to
  32 bytes and would produce a *different, non-matching* hash (`helpers.ts:136-141`).

### Sign-safety subtlety (uint32 ≥ 2³¹)

`durationSeconds` is a `uint32` on-chain but arrives in AS as an `i32`. A value
≥ 2³¹ arrives **negative** after `BigInt.toI32()` and sign-extends to `i64`.
Because `uintBytesBE` only emits the low `width` bytes and `& 0xff` masks each
one, the sign bits (which live *above* `width`) are never written — so the
uint32 preimage stays bit-for-bit correct across the full on-chain domain
(`helpers.ts:104-125`).

### The parity (three-way, test-pinned)

The 47-byte tight-packed preimage must stay identical across:
- the **contract** (`abi.encodePacked`),
- the **SDK** `computeMarketId` (`packages/sdk/src/resolveMarket.ts`),
- the **subgraph** `deriveMarketId`.

All three are pinned to the live Arbitrum Sepolia demo marketId
**`0x67c4bee1ee037851fbe2a8ecfdd0b8ae3d358283e940750c268621f776479d69`**
(dWETH, dUSDC, fee **500**, **604800s** = 7d) by two parity tests
(`helpers.ts:143-151`):
- `packages/contracts/test/MarketIdParity.t.sol` (on-chain side),
- `packages/sdk/src/marketid.parity.test.ts` (SDK / width-contract side).

That marketId matches `deployments/arbitrum-sepolia.json:74`
(`marketId_fee500_7d`). Any field-width change that breaks the match fails those
tests.

### How the mapping recovers the marketId from a `SwapCreated`

`SwapRecord` carries **no marketId** (`inflexion-core.ts:175`). The mapping
recovers it by: (1) reading `token0/token1/fee` from the NPM `positions()`
decode, (2) reading `expiry`/`createdAt` from `InflexionCore.swaps()` to compute
`durationSeconds`, then (3) calling `deriveMarketId` — **reusing the NPM bind, not
re-binding** (`inflexion-core.ts:203-237`). It needs all four fields: both the
geometry decode AND the swap-record read must succeed (`inflexion-core.ts:203`).

---

## 4. Entity catalogue (every entity, key fields, purpose, WHY)

All entities are `@entity(immutable: false)` (mutable, get-or-create + update)
**except `SigmaPoint`** which is `@entity(immutable: true)` (append-only).

### 4.1 `Market` — the market directory (`schema.graphql:22-46`)

The directory of tradeable markets, written from `MarketRegistered` + cvAMM
config events.

- **`id`** = `marketId` hex (the keccak above) (`schema.graphql:23`).
- Directory facts: `token0`, `token1`, `fee` (Int), `durationSeconds`,
  `durationBucket` (coarse: hour|day|week|month|longer), `oracleToken`, `active`
  (per Register/Deactivate), `cvammEnabled` (nullable Boolean — Path-A rail
  enabled, from `CvammEnabledSet`; null until first set) (`schema.graphql:26-35`).
- **Denormalised lifetime counters** (so directory reads are cheap, no scan over
  `Swap`): `totalSwaps`, `totalSettled`, `totalV0`, `totalPremium`,
  `totalPayout`, `pathBFills` (`schema.graphql:38-44`).
- `swaps: [Swap!]! @derivedFrom(field: "market")` — reverse lookup
  (`schema.graphql:45`).

**WHY two write paths:** the directory fields are *owned* by
`handleMarketRegistered` (`inflexion-core.ts:75-98`); the counters are bumped in
`handleSwapCreated` (`inflexion-core.ts:213-236`). A Market created by a swap
*before* its `MarketRegistered` lands is back-filled by that handler, which
*preserves the counters* on an existing entity (`inflexion-core.ts:77-86`,
`208-212`). This order-independence is deliberate.

### 4.2 `Swap` — the atomic per-fill lifecycle record (`schema.graphql:48-138`)

The central entity. Every per-fill signal joins on it. Reconstructs the full
lifecycle: **SwapCreated → QuoteFilled → SwapPriced → SwapSettled**
(`schema.graphql:49`).

- Enums: `SwapStatus {ACTIVE, SETTLED}` (`schema.graphql:53-56`);
  `SwapPath {UNKNOWN, POOL_A, MM_B}` (`schema.graphql:58-62`).
- **`id`** = `swapId` decimal string (`schema.graphql:65`).
- `status`, `isActive` (open-set membership for Signal 5; true between Created and
  Settled) (`schema.graphql:67-70`).
- **From `SwapCreated`:** `lp`, `mm` (counterparty — for **Path A this is the
  ConvexityVault**, for **Path B the MM EOA**), `tokenId`, `v0`, `maxIL`,
  `premium`, `createdAtBlock/Timestamp`, `expiryTimestamp`, `durationSeconds`
  (null until derivable) (`schema.graphql:72-84`).
- **Decoded geometry** (NPM.positions at the Created block): `tickLower`,
  `tickUpper`, `liquidity`, `widthBucket` (tight|medium|wide|full|unknown),
  `distanceBucket` (at-edge|near|mid|deep|unknown), `durationBucket`,
  `geometryDecoded` (`schema.graphql:86-96`).
- **From `SwapPriced`** (mechanical baseline, emitted on every create path):
  `path`, `priced`, `fairPremium`, `baseLoadWad`, `utilSkewWad`, `dispSkewWad`,
  `poolLoadWad` (pool mechanical load = price-to-beat; **for Path B this on-chain
  field is the MM load in WAD**), `sigmaRefWad` (the σ_ref the swap was priced
  against — also backfills the SigmaPoint series), `cappedAtMaxIL`
  (`schema.graphql:98-110`).
- **From `QuoteFilled` (Path B only — the non-circular datum):** `quoteId`,
  `nonce`, **`mmLoadBps`** = the MM's actor-chosen load in bps, *the single
  non-circular load datum* (`schema.graphql:112-116`).
- **From `SwapRouted` (routed-only):** `routed`, `routedPathB`, `premiumA`,
  `premiumB` — both candidate premiums (`schema.graphql:118-122`).
- **Derived (Signal 2):** `spreadWad` = `poolLoadWad − mmLoadBps(WAD)`, only
  meaningful on a Path-B win (null otherwise); `winDepth` = `premiumA − premiumB`
  on a routed Path-B win (win-depth) (`schema.graphql:124-128`).
- **From `SwapSettled`:** `realisedIL`, `payout`, `settlementPrice`,
  `settledAtBlock/Timestamp`, `pnlForMm` = `premium − payout`
  (`schema.graphql:130-137`).

### 4.3 `BucketAggregate` — Signals 1 (clearing load) & 3 (term structure) (`schema.graphql:140-174`)

The core moat aggregate. Keyed by the **(width × distance × duration)** triple;
**NON-CAPPED fills only**. The 7/30/90d rows of one (width, distance) pair give
the **term-structure slope** (Signal 3) (`schema.graphql:141-144`).

- **`id`** = `` `${widthBucket}-${distanceBucket}-${durationBucket}` ``
  (`schema.graphql:147`, built by `bucketId`, `helpers.ts:85-87`).
- Counts: `countPoolFills` (Path-A mechanical baseline), `countMMFills` (Path-B
  behavioral), `countMMWins` (path == MM_B, for win-rate), `totalNonCappedFills`
  (`schema.graphql:153-160`). The win-rate `countMMWins /
  (countPoolFills + countMMFills)` is computed by the API; the counts are
  canonical here (`schema.graphql:159`).
- **Running sums** over non-capped fills → API derives means/medians (the
  subgraph has no median operator): `sumMMLoadBps`, `sumPoolLoadWad`,
  `sumSpreadWad`, `sumSigmaRefWad` (Signal 1 normalises load over σ_ref),
  `sigmaRefFloor` (lowest σ_ref observed = regime floor), `v0Volume`
  (`schema.graphql:162-170`).
- `lastFillTimestamp`, `lastFillSwap` (`schema.graphql:172-173`).

**WHY sums not means:** the store cannot compute a median, and means must be
volume/time-windowed by the API — so the subgraph keeps *canonical running sums
and counts*, and the API does the division and windowing.

### 4.4 `GeometryDemandBucket` — REALIZED half of Signal 4 (demand skew) (`schema.graphql:176-191`)

The realized (filled) half of moneyness/demand-skew, keyed by the same geometry
triple, fed from `SwapCreated` + geometry decode. **The latent half (unfilled
interest) is off-chain telemetry served by the API** (`schema.graphql:177-179`).

- `id` (same `bucketId`), `widthBucket`, `distanceBucket`, `durationBucket`,
  `realizedFillCount`, `realizedV0`, `firstSeen`, `lastSeen`
  (`schema.graphql:182-190`).

**WHY separate from BucketAggregate:** demand skew counts *every* create
(including capped fills — demand is demand), whereas `BucketAggregate` excludes
capped fills (load info only). Different inclusion rules → different entity.

### 4.5 `NetGammaSnapshot` — Signal 5 (net convexity / gamma supply) (`schema.graphql:193-212`)

Protocol-wide, per time bucket. The subgraph maintains the **counts/sums over the
active-swap set**; the **Greeks fields are written back by the API/GreeksEngine**
(off-chain finite-difference of the deployed ILMath / FairValueOracle)
(`schema.graphql:194-198`).

- `id` = `` `${bucketStart}` ``, `bucketStart`, `activeSwapCount`, `totalV0`,
  `totalMaxIL` (`schema.graphql:200-206`).
- **`aggGammaWad`, `aggVegaWad`** — off-chain Greeks sums, **null until computed**
  by the API (`schema.graphql:207-209`).
- `volumeWeightedLoadWad` = `Σ(per-swap load × V0) / Σ V0`, populated by the API
  (`schema.graphql:210-211`).

> NOTE (uncertain / not-yet-wired): the schema reserves this entity and the
> manifest lists it under InflexionCore's entities (`subgraph.yaml:30`), but
> **no mapping handler currently writes a `NetGammaSnapshot` row** — Grep across
> `src/*` finds no `NetGammaSnapshot` write. The live active-set counters are
> maintained on `ProtocolState` instead (below); `ProtocolState.nextNetGammaBucket`
> exists to drive a future net-gamma bucket roll. Treat `NetGammaSnapshot` as a
> schema-ready, API-populated surface rather than an indexer-populated one.

### 4.6 `ProtocolState` — singleton live active-set counters (`schema.graphql:214-224`)

Singleton (`id = 'global'`) holding the current snapshot of the active-swap set
(Signal 5 current snapshot): `activeSwapCount`, `totalActiveV0`,
`totalActiveMaxIL`, `cumulativeSwaps`, `cumulativeSettled`, `nextNetGammaBucket`
(`schema.graphql:215-223`).

- Bumped on `SwapCreated` (add to active set, increment cumulative)
  (`inflexion-core.ts:258-264`) and decremented on `SwapSettled` (remove from
  active set, with floor-at-zero guards) (`inflexion-core.ts:468-476`).
- Created with all fields zeroed by `getProtocolState` (`entities.ts:16-29`).

### 4.7 `Depositor` — per (address, tranche) vault flow (`schema.graphql:226-245`)

ConvexityVault deposit/withdraw flow; carries the **claim-(B) "capital not
guaranteed"** framing (`schema.graphql:227-229`).

- `id` = `` `${address}-${tranche}` `` (**tranche 0 = senior, 1 = junior**)
  (`schema.graphql:232`, `helpers.ts:18-20,99-102`).
- `address`, `tranche`, `shares`, `totalDeposited`, `totalWithdrawn` (running, for
  realized-yield reconstruction), `pendingWithdrawShares`, `pendingUnlockAt`,
  `firstSeen`, `lastUpdated` (`schema.graphql:233-244`).
- Written by `handleDeposited` / `handleWithdrawRequested` / `handleWithdrawn`
  (`convexity-vault.ts:129-182`).

> CAVEAT (potential bug, flagged): `getDepositor` is keyed by the composite
> `${address}-${tranche}` id, but its internal `Depositor.load(addrHex)` is
> passed the *id* string while the local var is named `addrHex`
> (`convexity-vault.ts:38-39,131-132`). The id is correct (it's the composite),
> so per-tranche separation holds — the variable naming is just misleading. No
> correctness issue, but worth noting for anyone reading the code.

### 4.8 `MarketMaker` — Signal 2 per-MM win-rate + PnL (`schema.graphql:247-267`)

Per-MM aggregate (MM-10/MM-11). `id` = MM address.

- `fills`, `exposureV0`, `exposureMaxIL`, `cumulativePremium`,
  `cumulativePayout`, `pnl` (= premium − payout), `cumulativeWinCount` (Path-B
  wins: a SwapPriced with `path == MM_B` and this mm), `cumulativeQuoteFillCount`
  (total quotes via QuoteFilled), `firstSeen`, `lastSeen`
  (`schema.graphql:252-266`).
- **NOTE on "MM" for Path A:** `handleSwapCreated` bumps the counterparty's
  `MarketMaker` row for *every* swap, and on Path A the counterparty is the
  **ConvexityVault** (`inflexion-core.ts:248-256`). So the ConvexityVault address
  appears as a `MarketMaker` with `fills`/`exposure`/`premium` — the API should
  distinguish it. `cumulativeWinCount` and `cumulativeQuoteFillCount` only
  increment for genuine Path-B MMs (`inflexion-core.ts:362-367,413-416`).

### 4.9 `SigmaPoint` — the σ_ref series (immutable) (`schema.graphql:269-294`)

Per-(token, Poked) σ_ref EWMA series, **with SwapPriced backfill**. The only
`@entity(immutable: true)` entity (`schema.graphql:281`).

- Enum `SigmaSource {POKE, INITIALIZED, SWAP_PRICED_BACKFILL}`
  (`schema.graphql:275-279`).
- **`id`** = `` `${blockNumber}-${logIndex}` `` (the `eventUid`,
  `helpers.ts:89-92`) — **globally unique across all three data sources**, so the
  SwapPriced backfill points (written from InflexionCore) never collide with the
  Poked/Initialized points (written from VolOracle) (`schema.graphql:282`).
- `token`, `timestamp`, `blockNumber`, `priceWad`, `dtSeconds`, `sigmaShortWad`,
  `sigmaLongWad`, **`sigmaRefWad`** (carried forward), `source`
  (`schema.graphql:283-293`).

**WHY the gap-fill (load-bearing mechanic):** `poke()` is a **no-op (emits NO
`Poked`)** when `dt < minSampleInterval`, so on quiet feeds the series has holes
between pokes (`vol-oracle.ts:6-9`). The InflexionCore mapping fills the holes:
every `SwapPriced` with a positive `sigmaRefWad` writes a `SigmaPoint` with
`source = SWAP_PRICED_BACKFILL` (`inflexion-core.ts:302-316`), so a downstream
consumer sees a **continuous series** with no gaps.

σ_ref reconstruction in the VolOracle mapping: from a `Poked` event,
`sigmaRefWad = max(sigmaShortWad, sigmaLongWad)` ("max window binds" EWMA
semantics) (`vol-oracle.ts:16-35`); at `Initialized` both windows seed at the
floor, so `sigmaRefWad = floorWad` (`vol-oracle.ts:38-48`).

### 4.10 Pool snapshots: `PoolDaySnapshot` / `PoolHourSnapshot` / `PoolState` (`schema.graphql:296-344`)

NAV / util / premium time series (DEP-8/DEP-9, PUB-2; claim B).

- **`PoolDaySnapshot`** `id` = day index (`timestamp / 86400`); **`PoolHourSnapshot`**
  `id` = hour index (`timestamp / 3600`) (`schema.graphql:300-301,316-317`). Both
  carry `seniorAssets`, `juniorAssets`, `totalLocked`, **`utilWad`** (=
  `totalLocked / (seniorAssets + juniorAssets)`), `concWad`, `premiumAccrued`,
  `payouts`, `juniorLoss`, `seniorLoss` (`schema.graphql:302-329`).
- **`PoolState`** — singleton `id = 'global'` running NAV (the source the
  snapshots checkpoint): `seniorAssets`, `juniorAssets`, `totalLocked`, `concWad`,
  `cumulativePremiumAccrued`, `cumulativePayouts`, `cumulativeJuniorLoss`,
  `cumulativeSeniorLoss`, `lastUpdated` (`schema.graphql:331-344`).

**NAV reconstruction (the mechanics, `convexity-vault.ts:1-9,184-285`):**
deposits/withdrawals move principal per tranche; `PremiumAccrued` credits each
tranche (`toSenior`/`toJunior`) and bumps `cumulativePremiumAccrued`
(`convexity-vault.ts:184-193`); **`JuniorLoss` debits junior first, then senior**
(first-loss tranche order) (`convexity-vault.ts:270-285`) — this is the on-chain
encoding of the **junior first-loss / senior systemic-tail** model. Every flow
calls `checkpoint(ts)` to write the running state into the current day + hour
snapshots and `addFlow(...)` to accumulate the per-bucket flow deltas
(`convexity-vault.ts:61-127`).

### 4.11 `MarketStateSnapshot` — PUB-1 load surface per (market × day) (`schema.graphql:346-367`)

The per-market load surface + volume/share, keyed `` `${marketId}-${dayStart}` ``
(`schema.graphql:351`).

- `market` (ref), `dayStart`, `lockedByMarket`, nullable `utilWad`/`concWad`
  (protocol-wide accessors), `sigmaRefWad`, `baseLoadWad`, `utilSkewWad`,
  `dispSkewWad`, `totalLoadWad`, `fillCount`, `v0Volume`, `pathBFills`
  (`schema.graphql:352-366`).
- **Two writers, by design:** the *vault* writes `lockedByMarket`/`utilWad`/
  `concWad`/`fillCount` on `CollateralLocked` (the only ConvexityVault event
  carrying a marketId) (`convexity-vault.ts:202-255`). The *load-component*
  fields (`baseLoadWad`/.../`totalLoadWad`/`sigmaRefWad`) originate from
  `SwapPriced` (InflexionCore), **not the vault** — they are left null and the
  **API joins them by (market, day)** (`convexity-vault.ts:212-220,250-253`).

### 4.12 `Nonce` — (mm, nonce) fill/cancel state (`schema.graphql:369-383`)

Precise fill detection (MM-8). `id` = `` `${mm}-${nonce}` `` (`helpers.ts:94-97`).
Fields: `mm`, `nonce`, `filled`, `cancelled`, `swap` (the swap that consumed it),
`updatedAt` (`schema.graphql:373-382`).

**WHY it exists / the disambiguation:** on-chain `isNonceUsed` returns true on
**both** fill and cancel — the subgraph disambiguates: `QuoteFilled` sets
`filled = true` (`inflexion-core.ts:398-411`), while `NoncesCancelled` sets
`cancelled = true` **only if the nonce was not already filled**
(`inflexion-core.ts:479-497`, esp. `493`). This preserves invariant I7
(capacity authority: a cancelled bitmap-nonce bit cannot fill) in the indexed
view.

---

## 5. The event-order fix (load-bearing — the heart of Signal 2)

This is the single most important mapping subtlety, documented at length in the
file header (`inflexion-core.ts:13-22`) and inline (`inflexion-core.ts:318-360,
381-396`).

**On-chain emit order on every Path-B create:** `_executePathB` emits
`SwapCreated` + **`QuoteFilled`**, *then* `_emitPriced` emits **`SwapPriced`** —
i.e. **QuoteFilled fires BEFORE SwapPriced**. Verified in `InflexionCore.sol`:
`emit QuoteFilled(...)` at **L809** (inside `_executePathB`), and `_emitPriced`
called at **L909** (`createSwap`) and **L1008** (`createSwapRouted`) — both
*after* the `_executePathB` call on L908 / L1007.

**Consequence + fix:** the spread (Signal 2) and the non-circular MM-load
`BucketAggregate` accumulation are done in **`handleSwapPriced`** (the *later* of
the pair), because only there are *all three* needed values available
simultaneously:
1. the pool `totalLoadWad` (on the `SwapPriced` event itself),
2. the authoritative `cappedAtMaxIL` (on the `SwapPriced` event),
3. the swap's persisted `mmLoadBps` (written by the *earlier* `QuoteFilled`).

`handleQuoteFilled` therefore **only persists the per-swap MM fields**
(`quoteId/nonce/mmLoadBps`) and the Nonce/MM-count — it **must NOT** read
`poolLoadWad`/`cappedAtMaxIL`, which `handleSwapPriced` has not written yet
(`inflexion-core.ts:381-396`). Doing the accumulation in `handleQuoteFilled`
would read a not-yet-written `poolLoadWad`/`cappedAtMaxIL` → **spread always
null, capped fills miscounted** (`inflexion-core.ts:323-325`).

**The spread + MM-load math** (`inflexion-core.ts:335-353`): on a Path-B fill,
convert `mmLoadBps` → WAD as `loadBps × 1e14` (since `loadBps/10000 × 1e18 =
loadBps × 1e14`), then `spreadWad = totalLoadWad − mmLoadWad`; persist it on the
Swap and add to `sumMMLoadBps` / `sumSpreadWad`. A **phantom-zero guard** skips
this whole block if `s.mm == address(0)` (the defensive-create branch where a
SwapPriced was indexed without its SwapCreated/QuoteFilled — a re-org/replay
artefact) so a phantom 0 cannot poison the aggregates; a *real* fill (even a
legit 0-load one) always carries a non-zero `mm` from SwapCreated, so genuine
data is never dropped (`inflexion-core.ts:338-353`).

**Defensive create:** `handleSwapPriced` (`inflexion-core.ts:270-289`) and the
other lifecycle handlers tolerate out-of-order/cross-block arrival by
get-or-create with zeroed defaults, so pricing data is never dropped even if its
SwapCreated is missing.

---

## 6. Which event populates what (mapping map)

| Event | Handler | What it writes |
|---|---|---|
| `MarketRegistered` | `handleMarketRegistered` | Market directory fields; preserves counters (`inflexion-core.ts:75-98`) |
| `MarketDeactivated` | `handleMarketDeactivated` | `Market.active = false` (`inflexion-core.ts:100-105`) |
| `CvammEnabledSet` | `handleCvammEnabledSet` | `Market.cvammEnabled` (`inflexion-core.ts:107-112`) |
| `TreasurySet`/`CvammConfigured`/`CvammFrozen`/`LoadParamsSet` | no-op handlers | indexed for completeness; touch no entity (`inflexion-core.ts:114-119`) |
| `SwapCreated` | `handleSwapCreated` | new Swap + geometry decode + marketId recovery + Market counters + GeometryDemandBucket + MarketMaker exposure + ProtocolState active-set (`inflexion-core.ts:123-265`) |
| `SwapPriced` | `handleSwapPriced` | Swap pricing fields; SigmaPoint backfill; **BucketAggregate** (non-capped only); per-MM win count; per-market `pathBFills` (`inflexion-core.ts:267-379`) |
| `QuoteFilled` | `handleQuoteFilled` | Swap MM fields (`quoteId/nonce/mmLoadBps`); Nonce.filled; per-MM `cumulativeQuoteFillCount` (`inflexion-core.ts:381-417`) |
| `SwapRouted` | `handleSwapRouted` | Swap `routed/routedPathB/premiumA/premiumB/winDepth` (`inflexion-core.ts:419-432`) |
| `SwapSettled` | `handleSwapSettled` | Swap settlement fields + `pnlForMm`; per-MM payout/PnL; Market `totalSettled/totalPayout`; ProtocolState active-set decrement (`inflexion-core.ts:434-477`) |
| `NoncesCancelled` | `handleNoncesCancelled` | Nonce.cancelled (only if not filled) (`inflexion-core.ts:479-497`) |
| `Deposited` | `handleDeposited` | Depositor; PoolState per-tranche; checkpoint (`convexity-vault.ts:129-147`) |
| `WithdrawRequested` | `handleWithdrawRequested` | Depositor pending fields (`convexity-vault.ts:149-156`) |
| `Withdrawn` | `handleWithdrawn` | Depositor; PoolState per-tranche; checkpoint (`convexity-vault.ts:158-182`) |
| `PremiumAccrued` | `handlePremiumAccrued` | PoolState tranche credit; checkpoint; addFlow (`convexity-vault.ts:184-193`) |
| `CollateralLocked` | `handleCollateralLocked` | PoolState totalLocked; checkpoint; MarketStateSnapshot (`convexity-vault.ts:195-255`) |
| `SettlementReleased` | `handleSettlementReleased` | PoolState unlock + cumulativePayouts; addFlow (`convexity-vault.ts:257-268`) |
| `JuniorLoss` | `handleJuniorLoss` | PoolState junior-then-senior debit; addFlow (`convexity-vault.ts:270-285`) |
| `Poked` | `handlePoked` | SigmaPoint (source POKE) (`vol-oracle.ts:24-36`) |
| `Initialized` | `handleInitialized` | SigmaPoint (source INITIALIZED) (`vol-oracle.ts:38-48`) |

---

## 7. The bucketing classifiers (the moat coordinate system)

The aggregates key on a **(width × distance × duration)** triple chosen to mirror
the off-chain engine telemetry buckets, so the realized (on-chain) and latent
(off-chain) halves of Signals 2/4 **share one coordinate system the API can join
on** (`helpers.ts:1-9,26-27`).

- **Duration bucket** (`helpers.ts:39-46`): `≤0 → unknown`, `≤3600 → hour`,
  `≤86400 → day`, `≤604800 → week`, `≤2592000 → month`, else `longer`.
- **Width bucket** from tick span `tickUpper − tickLower` (1 tick ≈ 1bp price
  ratio, monotone in `log(Pb/Pa)`) (`helpers.ts:48-64`): `≤0 → unknown`,
  `≤600 → tight (~±3%)`, `≤2000 → medium (~±10%)`, `≤10000 → wide (~±65%)`,
  else `full` (near full-range).
- **Distance bucket** (`helpers.ts:66-82`): on-chain reports **`mid`** for a
  well-formed range (and `unknown` for a degenerate one) because, without an
  oracle P0 in the handler, ticks alone only give the geometric centre. The
  precise `at-edge / near / deep` classification is **computed by the API** from
  P0 vs (Pa, Pb). (So on-chain the distance axis is effectively `mid|unknown`
  today — flagged as a known coarse proxy in the code comment.)

---

## 8. GraphQL query examples (the key surfaces)

> Endpoint (once the Studio slug is live):
> `https://api.studio.thegraph.com/query/<id>/inflexion-arb-sepolia/<version>`.
> Pending until the slug `inflexion-arb-sepolia` is created (`package.json:13`);
> until then the API serves these from a typed pending state.

### 8.1 A market's swaps (the per-fill lifecycle for one market)

```graphql
query MarketSwaps {
  market(id: "0x67c4bee1ee037851fbe2a8ecfdd0b8ae3d358283e940750c268621f776479d69") {
    fee
    durationSeconds
    active
    cvammEnabled
    totalSwaps
    totalSettled
    pathBFills
    totalV0
    totalPremium
    totalPayout
    swaps(orderBy: createdAtTimestamp, orderDirection: desc, first: 50) {
      id
      status
      path                # POOL_A | MM_B | UNKNOWN
      lp
      mm                  # ConvexityVault on Path A, MM EOA on Path B
      v0
      maxIL
      premium
      widthBucket
      distanceBucket
      durationBucket
      cappedAtMaxIL
      mmLoadBps           # non-null only on Path B
      poolLoadWad
      spreadWad           # poolLoad − mmLoad(WAD); non-null only on a Path-B win
      premiumA
      premiumB
      winDepth
      realisedIL
      payout
      pnlForMm
    }
  }
}
```

### 8.2 The load surface (Signal 1 clearing-load + Signal 3 term structure)

The **clearing load over σ_ref, bucketed by geometry** lives in
`BucketAggregate`. The API derives means as `sum / count` and the term-structure
slope by comparing the `…-week` / `…-month` / `…-longer` rows of one (width,
distance) pair.

```graphql
query LoadSurface {
  bucketAggregates(orderBy: v0Volume, orderDirection: desc) {
    id                    # `${width}-${distance}-${duration}`
    widthBucket
    distanceBucket
    durationBucket
    totalNonCappedFills
    countPoolFills
    countMMFills
    countMMWins           # API: win-rate = countMMWins / (countPool+countMM)
    sumMMLoadBps          # API: meanMMLoad = sumMMLoadBps / countMMFills
    sumPoolLoadWad        # mechanical baseline (price-to-beat)
    sumSpreadWad          # Signal 2 realized spread accumulator
    sumSigmaRefWad        # Signal 1: normalise load over σ_ref
    sigmaRefFloor         # regime floor
    v0Volume
    lastFillTimestamp
  }
}
```

Term-structure slope (Signal 3) for one geometry — query the duration ladder:

```graphql
query TermStructure {
  bucketAggregates(where: { widthBucket: "tight", distanceBucket: "mid" }) {
    durationBucket        # day | week | month | longer
    sumMMLoadBps
    countMMFills
    sumSigmaRefWad
    totalNonCappedFills
  }
}
```

### 8.3 Net gamma / active-swap set (Signal 5)

Current snapshot (the live counters maintained by the indexer):

```graphql
query NetGammaNow {
  protocolState(id: "global") {
    activeSwapCount
    totalActiveV0
    totalActiveMaxIL
    cumulativeSwaps
    cumulativeSettled
  }
}
```

The Greeks series (API-populated; null until the GreeksEngine writes back):

```graphql
query NetGammaSeries {
  netGammaSnapshots(orderBy: bucketStart, orderDirection: asc) {
    bucketStart
    activeSwapCount
    totalV0
    totalMaxIL
    aggGammaWad           # null until API back-fills
    aggVegaWad            # null until API back-fills
    volumeWeightedLoadWad
  }
}
```

### 8.4 Pool / depositor surfaces (claim B — capital not guaranteed)

```graphql
query PoolHealth {
  poolState(id: "global") {
    seniorAssets
    juniorAssets
    totalLocked          # utilWad = totalLocked / (senior+junior)
    cumulativePremiumAccrued
    cumulativePayouts
    cumulativeJuniorLoss
    cumulativeSeniorLoss
  }
  poolDaySnapshots(orderBy: dayStart, orderDirection: desc, first: 30) {
    dayStart
    seniorAssets
    juniorAssets
    utilWad
    premiumAccrued
    payouts
    juniorLoss           # first-loss debited here before senior
    seniorLoss
  }
}
```

### 8.5 σ_ref series (continuous, gap-filled)

```graphql
query SigmaSeries {
  sigmaPoints(orderBy: timestamp, orderDirection: asc, first: 200) {
    timestamp
    token
    sigmaShortWad
    sigmaLongWad
    sigmaRefWad
    source               # POKE | INITIALIZED | SWAP_PRICED_BACKFILL
  }
}
```

### 8.6 Per-MM leaderboard (Signal 2 per-MM)

```graphql
query MMLeaderboard {
  marketMakers(orderBy: pnl, orderDirection: desc) {
    id                   # NOTE: ConvexityVault address also appears (Path-A counterparty)
    fills
    exposureV0
    exposureMaxIL
    cumulativePremium
    cumulativePayout
    pnl
    cumulativeWinCount        # genuine Path-B wins only
    cumulativeQuoteFillCount  # genuine Path-B quotes only
  }
}
```

---

## 9. Why this is the data moat (the framing)

The subgraph is what turns Inflexion from "a protocol" into "the first public
view into the microstructure of the DeFi LP volatility-risk premium." The five
signals it structurally captures (the *realized* halves; the dynamic halves are
API telemetry):

1. **Clearing load over a transparent σ_ref, bucketed by geometry** —
   `BucketAggregate` (`sum*Load` / `sumSigmaRefWad` per geometry triple).
2. **Pool-vs-MM spread** — `Swap.spreadWad` + `BucketAggregate.sumSpreadWad`
   (the non-circular MM load minus the mechanical baseline).
3. **Convexity term structure** — the duration ladder of `BucketAggregate`.
4. **Demand skew (moneyness)** — `GeometryDemandBucket` (realized half;
   latent half is API telemetry).
5. **Net gamma** — `ProtocolState` live counters + `NetGammaSnapshot`
   (API-computed Greeks).

These are **non-circular**: the load is an actor's chosen price (MM `loadBps`) or
a transparent mechanical baseline (pool `totalLoadWad`), never an inverted
fair-rate; capped fills (zero load info) are excluded. **The structures are
present day-one** (the bucketing + sums populate from the first fill); the
*dynamics* mature as MM count and flow volume grow.

---

## 10. Key facts & caveats checklist (for judge prep)

- **Start block 274081134** = the 2026-06-05 FULL-FRESH redeploy block; the moat
  dataset begins there (`subgraph.yaml:20`, `deployments/...json:40`).
- **`marketId` parity** is three-way and test-pinned to
  `0x67c4bee1…9d69` (dWETH/dUSDC/500/604800s) across contract, SDK, subgraph
  (`helpers.ts:143-164`).
- **Event-order fix:** QuoteFilled before SwapPriced ⇒ spread + non-circular
  MM-load accumulation live in `handleSwapPriced` (`inflexion-core.ts:13-22,
  318-360`; contract L809 → L909/L1008).
- **Cap exclusion:** `cappedAtMaxIL` fills are excluded from load aggregates
  (`inflexion-core.ts:326`) — zero load info.
- **σ_ref gap-fill:** `SWAP_PRICED_BACKFILL` SigmaPoints make the series
  continuous when `poke()` no-ops on quiet feeds (`inflexion-core.ts:302-316`,
  `vol-oracle.ts:6-9`).
- **NPM never hardcoded** — templated into `generated-addresses.ts` from the
  single registry (`gen-manifest.mjs:39-42,185-196`).
- **Deploy pending** until the `inflexion-arb-sepolia` Studio slug exists
  (`package.json:13`); history degrades to a typed pending state.
- **Flagged uncertainties:** (a) `NetGammaSnapshot` is schema-ready/API-populated,
  not currently written by any mapping handler (no write found in `src/*`);
  (b) on-chain `distanceBucket` is effectively `mid|unknown` (API refines with P0)
  (`helpers.ts:66-82`); (c) the ConvexityVault appears in `MarketMaker` as the
  Path-A counterparty (`inflexion-core.ts:248-256`).
