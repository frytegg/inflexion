# @inflexion/engine — Path-B quote relayer (P4.a)

A **thin** off-chain relayer for the optional Path-B (market-maker) rail. It does
**not** match or settle — the chain does that (`createSwapRouted` re-derives the
FairPremium, routes to the cheaper of {pool, MM quote}, and settles from the MM's
collateral). The relayer only:

1. accepts EIP-712 signed quotes streamed by a market maker over **WebSocket**,
   verifies the signature + basic freshness, and stores the latest per (market, MM);
2. serves the cheapest current quote for a market over **`GET /quote`**;
3. (optionally) appends every accepted quote to a JSONL log.

Path A (the cvAMM pool) needs no relayer — this package exists only so a
sophisticated MM can compete on price. See `apps/docs/market-makers.mdx`.

## Shared quote helpers (`@inflexion/engine/quote`)

`src/quote.ts` is the single source of truth for the `SignedQuote` EIP-712 schema —
field order, types, and the `("Inflexion", "1")` domain all match
`InflexionCore.SignedQuote` / `SIGNED_QUOTE_TYPEHASH` exactly, so a quote signed
here verifies on-chain. The SDK (P4.b) and the MM bot both import it.

```ts
import { signQuote, verifyQuote, type SignedQuote } from '@inflexion/engine/quote'
const env = await signQuote(privateKey, quote, 421614, coreAddress) // -> { quote, signature }
```

## Run

```bash
pnpm --filter @inflexion/engine build
# VERIFYING_CONTRACT defaults to the registry's core.inflexionCore; override only for a non-default deploy:
PORT=8787 pnpm --filter @inflexion/engine start

# example MM bot (separate process):
MM_PRIVATE_KEY=0x… MARKET_ID=0x… LOAD_BPS=500 pnpm --filter @inflexion/engine mm-bot
```

| Surface                   | Purpose                                       |
| ------------------------- | --------------------------------------------- |
| `WS ws://host:PORT`       | MM streams `{type:"quote", quote, signature}` |
| `GET /quote?marketId=0x…` | cheapest live quote for a market (taker side) |
| `GET /health`             | liveness + market count                       |

## Status / not yet done

- `/quote` returns the signed quote + `loadBps`; it does **not** yet compute a
  dollar premium (that is position-specific and derived on-chain — wired with the
  SDK in P4.b, which adds an RPC read of `FairPremium`).
- Single-MM scope; no auth, no rate-limit, no persistence beyond the JSONL log.
- The definitive Stylus≡Solidity≡off-chain digest cross-check (signing here vs
  `InflexionCore.hashQuote` over RPC) is an integration test added with P4.b.
