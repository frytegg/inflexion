/**
 * OpenAPI 3.1 description of the public read-only facade, served at
 * `/openapi.json` (machine-readable) with a tiny Swagger-UI shell at `/docs`.
 *
 * This is hand-authored (no codegen, no network) so it stays offline-CI-safe and
 * a single source of truth for the endpoint contract. Every response is one of two
 * shapes — `{ available: true, ... }` or a typed `pending` body — so the schema
 * models that discriminated union once and references it everywhere.
 *
 * The endpoint list mirrors app.ts exactly; keep them in sync when adding routes.
 */

/** The OpenAPI document (returned verbatim at GET /openapi.json). */
export const OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'Inflexion Public Data API',
    version: '0.0.0',
    description:
      'Read-only, cached, public facade over the Inflexion subgraph (history / ' +
      'aggregates), a few live RPC reads (via @inflexion/sdk — current pool-load ' +
      'surface, pool state, pricing preview), and the engine telemetry sinks ' +
      '(Signals 2 & 4 dynamic halves). No wallet, no RPC key for consumers. ' +
      'Every surface degrades gracefully: subgraph-backed routes return a typed ' +
      '`pending` body (with the future GraphQL query embedded) until the subgraph ' +
      'is deployed at the single redeploy; live + telemetry routes return real data now.',
  },
  servers: [{ url: '/', description: 'this service' }],
  tags: [
    { name: 'system', description: 'health + service metadata' },
    { name: 'markets', description: 'market directory + per-market state' },
    { name: 'pool', description: 'vault NAV / state / history (claim B: capital NOT guaranteed)' },
    { name: 'swaps', description: 'protection swaps (claim A: no bad debt in FULL, qualified)' },
    { name: 'pricing', description: 'live cached fair + pool premium preview' },
    { name: 'data', description: 'the five data-moat signals (snapshot + series)' },
    { name: 'mm', description: 'market-maker fills / PnL' },
    { name: 'sigma', description: 'σ_ref history' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['system'],
        summary: 'Liveness + backing-source status (subgraph / live RPC / telemetry sinks).',
        responses: { '200': okJson('HealthResponse') },
      },
    },
    '/openapi.json': {
      get: {
        tags: ['system'],
        summary: 'This OpenAPI 3.1 document.',
        responses: { '200': okJson() },
      },
    },
    '/docs': {
      get: {
        tags: ['system'],
        summary: 'Minimal Swagger-UI shell rendering /openapi.json.',
        responses: { '200': { description: 'HTML docs page' } },
      },
    },
    '/markets': {
      get: {
        tags: ['markets'],
        summary: 'Market directory (subgraph). Pending until the subgraph is deployed.',
        responses: { '200': okJson('ApiResult') },
      },
    },
    '/markets/{id}': {
      get: {
        tags: ['markets'],
        summary: 'One market by id (subgraph + cached live inventory/σ_ref).',
        parameters: [pathParam('id', 'bytes32 marketId (0x…64 hex)')],
        responses: { '200': okJson('ApiResult') },
      },
    },
    '/pool': {
      get: {
        tags: ['pool'],
        summary:
          'LIVE vault state composite (NAV, senior/junior assets, util, conc, the two ' +
          'skews, regime). Reuses the SDK getVaultState; carries the claim-B disclosure ' +
          '(depositor capital is NOT guaranteed). Pending if no RPC is wired.',
        parameters: [
          {
            name: 'marketIds',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'comma-separated bytes32 marketIds for the lockedByMarket (HHI) colour.',
          },
        ],
        responses: { '200': okJson('ApiResult') },
      },
    },
    '/pool/nav-history': {
      get: {
        tags: ['pool'],
        summary: 'Per-tranche NAV time series (subgraph; claim B). bucket=day|hour.',
        parameters: [queryParam('bucket', 'day | hour (default day)')],
        responses: { '200': okJson('ApiResult') },
      },
    },
    '/pool/load-surface': {
      get: {
        tags: ['pool'],
        summary:
          'LIVE current pool-load surface across markets (the SDK multicall; price-to-beat).',
        parameters: [queryParam('marketIds', 'comma-separated bytes32 marketIds')],
        responses: { '200': okJson('ApiResult') },
      },
    },
    '/swaps': {
      get: {
        tags: ['swaps'],
        summary:
          'Recent swaps (subgraph). Optional filters: status=active|settled, mm, market. ' +
          'Carries the claim-A payout disclosure.',
        parameters: [
          queryParam('status', 'active | settled (optional)'),
          queryParam('mm', 'MM address filter (optional)'),
          queryParam('market', 'bytes32 marketId filter (optional)'),
          queryParam('first', 'page size (default 100, max 1000)'),
        ],
        responses: { '200': okJson('ApiResult') },
      },
    },
    '/swaps/{swapId}': {
      get: {
        tags: ['swaps'],
        summary: 'One swap by id (subgraph; claim A payout disclosure).',
        parameters: [pathParam('swapId', 'decimal swap id')],
        responses: { '200': okJson('ApiResult') },
      },
    },
    '/pricing/preview': {
      get: {
        tags: ['pricing'],
        summary:
          'LIVE cached fair + pool premium preview for a market (reuses the SDK current ' +
          'load surface — the API never re-derives the fair rate). Pending if no RPC.',
        parameters: [
          { name: 'marketId', in: 'query', required: true, schema: { type: 'string' } },
          queryParam('a', 'a = (Pa/P0)² WAD (optional; neutral reference if omitted)'),
          queryParam('b', 'b = (Pb/P0)² WAD (optional)'),
          queryParam('maxIL', 'MaxIL raw (optional; reference cap if omitted)'),
        ],
        responses: { '200': okJson('ApiResult') },
      },
    },
    '/data/load-surface': {
      get: {
        tags: ['data'],
        summary: 'Historical load-surface evolution (subgraph MarketStateSnapshot). Signal 1.',
        parameters: [queryParam('marketId', 'bytes32 marketId')],
        responses: { '200': okJson('ApiResult') },
      },
    },
    '/data/convexity-surface': {
      get: {
        tags: ['data'],
        summary:
          'Signal 1 (realized clearing load over σ_ref) + Signal 2 structural (pool-vs-MM ' +
          'spread) bucketed by width × distance × duration, EXCLUDING cap-bound fills.',
        responses: { '200': okJson('ApiResult') },
      },
    },
    '/data/term-structure': {
      get: {
        tags: ['data'],
        summary: 'Signal 3 — term-structure slope across 7/30/90d per range.',
        parameters: [
          queryParam('width', 'width bucket (default medium)'),
          queryParam('distance', 'distance bucket (default mid)'),
        ],
        responses: { '200': okJson('ApiResult') },
      },
    },
    '/data/demand-requests': {
      get: {
        tags: ['data'],
        summary:
          'Signal 4 — moneyness/demand skew: realized half (subgraph) + latent half ' +
          '(engine DEMAND_LOG telemetry, LIVE now).',
        parameters: [queryParam('marketId', 'optional filter'), queryParam('since', 'unix ts')],
        responses: { '200': okJson('ApiResult') },
      },
    },
    '/data/quote-competition': {
      get: {
        tags: ['data'],
        summary:
          'Signal 2 dynamic half — quote competition from the engine COMPETITION_LOG ' +
          '(winners AND losers). Pending if the sink is absent.',
        parameters: [queryParam('marketId', 'optional filter'), queryParam('since', 'unix ts')],
        responses: { '200': okJson('ApiResult') },
      },
    },
    '/data/net-gamma': {
      get: {
        tags: ['data'],
        summary: 'Signal 5 — net convexity / gamma supply (off-chain Greeks over the open set).',
        responses: { '200': okJson('ApiResult') },
      },
    },
    '/data/supply-depth': {
      get: {
        tags: ['data'],
        summary: 'Signal 5 raw active-swap set (subgraph isActive open set).',
        responses: { '200': okJson('ApiResult') },
      },
    },
    '/mm/{address}/fills': {
      get: {
        tags: ['mm'],
        summary: 'MM fills + PnL aggregate (subgraph).',
        parameters: [pathParam('address', 'MM address (0x…40 hex)')],
        responses: { '200': okJson('ApiResult') },
      },
    },
    '/sigma/{token}/history': {
      get: {
        tags: ['sigma'],
        summary: 'σ_ref history for a token (subgraph; includes SwapPriced backfill points).',
        parameters: [pathParam('token', 'token address (0x…40 hex)')],
        responses: { '200': okJson('ApiResult') },
      },
    },
  },
  components: {
    schemas: {
      Pending: {
        type: 'object',
        required: ['available', 'reason', 'detail'],
        properties: {
          available: { const: false },
          reason: {
            type: 'string',
            enum: [
              'subgraph-not-deployed',
              'subgraph-unreachable',
              'rich-events-pre-redeploy',
              'telemetry-sink-absent',
              'rpc-unavailable',
            ],
          },
          detail: { type: 'string' },
          query: { type: 'string', description: 'the future GraphQL query this surface will run' },
        },
      },
      Available: {
        type: 'object',
        required: ['available'],
        properties: { available: { const: true } },
        additionalProperties: true,
      },
      ApiResult: {
        oneOf: [
          { $ref: '#/components/schemas/Available' },
          { $ref: '#/components/schemas/Pending' },
        ],
        description: 'Every data endpoint returns this discriminated union — never throws.',
      },
      HealthResponse: {
        type: 'object',
        required: ['ok', 'subgraph', 'live', 'telemetry'],
        properties: {
          ok: { type: 'boolean' },
          subgraph: { type: 'boolean', description: 'a subgraph URL is configured' },
          live: { type: 'boolean', description: 'an RPC is wired for the live surfaces' },
          telemetry: {
            type: 'object',
            properties: {
              demand: { type: 'boolean' },
              competition: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
} as const

function okJson(schemaName?: string): {
  description: string
  content: { 'application/json': { schema: Record<string, unknown> } }
} {
  const schema = schemaName === undefined ? {} : { $ref: `#/components/schemas/${schemaName}` }
  return { description: 'OK', content: { 'application/json': { schema } } }
}

function pathParam(name: string, description: string) {
  return { name, in: 'path' as const, required: true, schema: { type: 'string' }, description }
}

function queryParam(name: string, description: string) {
  return { name, in: 'query' as const, required: false, schema: { type: 'string' }, description }
}

/** The minimal Swagger-UI HTML shell served at GET /docs (CDN UI, local spec). */
export const DOCS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Inflexion Public Data API — docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.onload = () => {
        window.SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui' })
      }
    </script>
  </body>
</html>
`
