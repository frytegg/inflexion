# @inflexion/sdk

The typed TypeScript access layer over the live Inflexion deployment. One factory call wires a read client (and an optional write client) into five surfaces; no contract address is ever passed in — every address loads from the on-chain registry.

```ts
import { createInflexionSdk } from '@inflexion/sdk'

const sdk = createInflexionSdk({ publicClient }) // read-only
// const sdk = createInflexionSdk({ rpcUrl, privateKey }) // with a signer
```

## Surfaces

- **`sdk.lp`** — buy in-range IL protection: preview the premium, buy (routed to the cheaper of pool vs MM), track, settle.
- **`sdk.depositor`** — underwrite via the dual-tranche `ConvexityVault` (senior / junior): deposit, read vault state, withdraw under cooldown.
- **`sdk.mm`** — Path-B market making: the geometry-free "pool load to beat", firm EIP-712 quote signing (I10 + below-pool guards), the requote loop, book / capacity.
- **`sdk.data`** — the live load surface plus the data-moat history surfaces (read-only).
- **`sdk.greeks` / `sdk.hedge`** — read-only analytics: δ / γ / vega / θ and a three-leg hedge suggestion, all finite-differenced off the protocol's own deployed math (never a parallel pricing model).

## Design properties

- **Reads degrade gracefully** — anything needing a reverting oracle or an absent history source returns a typed `{ available: false }` / `{ priceable: false }` envelope; it never throws.
- **Writes throw or defer without a wallet** — with no signer the SDK still constructs; a write either throws a clear error or returns the unsigned transaction.
- **The fair price is never reimplemented off-chain** — the SDK reads the on-chain `FairPremium` from the Stylus oracle; only the deterministic load stack is mirrored client-side (parity-locked to the deployed library).

## Develop

```bash
pnpm --filter @inflexion/sdk build
pnpm --filter @inflexion/sdk test
```

Full reference: the Mintlify docs (`apps/docs`).
