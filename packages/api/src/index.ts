/**
 * @inflexion/api — public, read-only, cached facade over the @inflexion/subgraph
 * (history/aggregates) + the engine telemetry sinks (Signals 2 & 4 dynamic halves)
 * + a small set of cached LIVE RPC reads via @inflexion/sdk (the current pool-load
 * surface — the SDK owns pricing; the API never re-derives the fair rate/load).
 *
 * No wallet, no RPC key for consumers. Every surface degrades gracefully:
 *   - subgraph not deployed yet  → typed `pending` with the future GraphQL query
 *   - rich events pre-redeploy   → empty/`pending` (the moat dataset begins then)
 *   - RPC absent                 → live endpoints `pending`, never crash
 *   - telemetry sink absent      → dynamic halves `pending`, never crash
 *
 * This barrel exports `buildDeps` (env/config → wired deps) + the app factory +
 * the pure handlers + the typed envelopes + the GraphQL query strings, so the API
 * is fully testable OFFLINE.
 */
import { makePublicClient, DataClient, DepositorClient } from '@inflexion/sdk'
import { SubgraphClient } from './subgraph.js'
import { TelemetryReader } from './telemetry.js'
import { TtlCache } from './cache.js'
import type { HandlerDeps } from './handlers.js'

export * from './types.js'
export * from './queries.js'
export * from './cache.js'
export * from './subgraph.js'
export * from './telemetry.js'
export * from './handlers.js'
export * from './app.js'
export * from './openapi.js'

/** Config for {@link buildDeps}. Everything optional — absent backings degrade. */
export interface ApiConfig {
  /** Deployed subgraph GraphQL endpoint. Absent ⇒ subgraph surfaces `pending`. */
  subgraphUrl?: string
  /** RPC URL for the ONE live surface (current pool-load). Absent ⇒ live `pending`. */
  rpcUrl?: string
  /** Engine Signal-4 latent-demand JSONL path (read-only). */
  demandLogPath?: string
  /** Engine Signal-2 quote-competition JSONL path (read-only). */
  competitionLogPath?: string
  /** Pre-built SDK DataClient (tests/custom RPC). Overrides `rpcUrl`. */
  data?: DataClient
  /** Pre-built SDK DepositorClient for `/pool` (tests/custom RPC). Overrides `rpcUrl`. */
  depositor?: DepositorClient
  /** Pre-built subgraph client (tests). Overrides `subgraphUrl`. */
  subgraph?: SubgraphClient
  /** Pre-built telemetry reader (tests). Overrides the log paths. */
  telemetry?: TelemetryReader
  /** Injected fetch for the subgraph client (tests/offline). */
  fetchImpl?: typeof fetch
}

/**
 * Wire a config into the handler deps. The DataClient (the only live RPC surface)
 * is constructed ONLY when an RPC url is supplied — so with no RPC the live
 * endpoints honestly report `rpc-unavailable` instead of silently hitting a
 * default public node.
 */
export function buildDeps(cfg: ApiConfig = {}): HandlerDeps {
  const subgraph =
    cfg.subgraph ??
    new SubgraphClient({
      ...(cfg.subgraphUrl !== undefined ? { url: cfg.subgraphUrl } : {}),
      ...(cfg.fetchImpl !== undefined ? { fetchImpl: cfg.fetchImpl } : {}),
    })

  const telemetry =
    cfg.telemetry ??
    new TelemetryReader({
      ...(cfg.demandLogPath !== undefined ? { demandLogPath: cfg.demandLogPath } : {}),
      ...(cfg.competitionLogPath !== undefined
        ? { competitionLogPath: cfg.competitionLogPath }
        : {}),
    })

  // Construct the live SDK surfaces ONLY when an RPC url is supplied, sharing one
  // public client across DataClient (current-load surface + pricing preview) and
  // DepositorClient (vault state). With no RPC the live endpoints honestly report
  // `rpc-unavailable` instead of silently hitting a default public node.
  let data = cfg.data
  let depositor = cfg.depositor
  if ((data === undefined || depositor === undefined) && cfg.rpcUrl !== undefined) {
    const publicClient = makePublicClient({ rpcUrl: cfg.rpcUrl })
    if (data === undefined) data = new DataClient(publicClient)
    if (depositor === undefined) depositor = new DepositorClient({ publicClient })
  }

  return {
    subgraph,
    telemetry,
    cache: new TtlCache(),
    ...(data !== undefined ? { data } : {}),
    ...(depositor !== undefined ? { depositor } : {}),
  }
}
