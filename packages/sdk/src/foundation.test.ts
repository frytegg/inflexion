/**
 * Foundation smoke tests — addresses registry, decoders, marketId derivation,
 * and the engine quote re-export. All offline.
 */
import { describe, expect, it } from 'vitest'
import { isAddress, getAddress } from 'viem'
import { addresses, core, stylus, libs, npm, tokens, demo, CHAIN_ID } from './addresses.js'
import { computeMarketId } from './resolveMarket.js'
import { decodeMarketConfig, decodeLoadParams, decodeSwapRecord } from './decode.js'
import { signQuote, SIGNED_QUOTE_TYPE_STRING } from './quote.js'

describe('addresses registry', () => {
  it('exposes the chain id and checksummed addresses from the deployment json', () => {
    expect(CHAIN_ID).toBe(421614)
    const all = [
      core.inflexionCore,
      core.oracleManager,
      core.volOracle,
      core.ilMath,
      core.underwriterVault,
      core.convexityVault,
      stylus.fairValueOracle,
      libs.cvammPricing,
      libs.tickMath,
      npm,
      tokens.demoWeth,
      tokens.demoUsdc,
      demo.marketMaker,
    ]
    for (const a of all) {
      expect(isAddress(a)).toBe(true)
      // checksummed (getAddress is idempotent on an already-checksummed address)
      expect(getAddress(a)).toBe(a)
    }
  })

  it('exposes the demo market ids + token id', () => {
    expect(demo.marketId_fee500_7d).toMatch(/^0x[0-9a-fA-F]{64}$/)
    expect(demo.shortMarketId_fee500_300s).toMatch(/^0x[0-9a-fA-F]{64}$/)
    expect(demo.lpPositionTokenId).toBe(3174n)
    expect(addresses.chainId).toBe(421614)
  })
})

describe('marketId derivation matches the on-chain pre-image', () => {
  it('reproduces the seeded demo fee-500 7d marketId from (token0,token1,fee,7d)', () => {
    // token0 = dWETH, token1 = dUSDC (numéraire), fee = 500, duration = 7d.
    const id = computeMarketId(tokens.demoWeth, tokens.demoUsdc, demo.poolFee, 7 * 24 * 60 * 60)
    expect(id.toLowerCase()).toBe(demo.marketId_fee500_7d.toLowerCase())
  })

  it('reproduces the seeded short (300s) lifecycle marketId', () => {
    const id = computeMarketId(tokens.demoWeth, tokens.demoUsdc, demo.poolFee, 300)
    expect(id.toLowerCase()).toBe(demo.shortMarketId_fee500_300s.toLowerCase())
  })
})

describe('tuple decoders', () => {
  it('decodes a markets() tuple positionally', () => {
    const cfg = decodeMarketConfig(demo.marketId_fee500_7d, [
      tokens.demoWeth,
      tokens.demoUsdc,
      500,
      604800,
      tokens.demoWeth,
      18,
      6,
      8,
      true,
    ])
    expect(cfg.token1).toBe(tokens.demoUsdc)
    expect(cfg.fee).toBe(500)
    expect(cfg.durationSeconds).toBe(604800)
    expect(cfg.active).toBe(true)
  })

  it('decodes a loadParams() tuple positionally', () => {
    const p = decodeLoadParams([
      2000n,
      3000n,
      5000n,
      6n * 10n ** 17n,
      1025n * 10n ** 15n,
      45n * 10n ** 16n,
      6n * 10n ** 17n,
      2n * 10n ** 18n,
      6n * 10n ** 17n,
      5n * 10n ** 17n,
      15n * 10n ** 17n,
      5n * 10n ** 17n,
      16000n,
    ])
    expect(p.baseLoadCalmBps).toBe(2000n)
    expect(p.maxLoadBps).toBe(16000n)
  })

  it('decodes a swaps() tuple with NO marketId field', () => {
    const s = decodeSwapRecord([
      3174n,
      demo.marketMaker,
      core.convexityVault,
      120351n,
      706n,
      706n,
      28n,
      0,
      0,
      100n,
      700n,
      1n,
      2n,
      99n,
      1,
    ])
    expect(s.tokenId).toBe(3174n)
    expect(s.mm).toBe(core.convexityVault) // Path A → mm == convexityVault
    expect(s.status).toBe(1) // ACTIVE
    expect((s as unknown as { marketId?: unknown }).marketId).toBeUndefined()
  })
})

describe('engine quote re-export', () => {
  it('re-exports signQuote + the SIGNED_QUOTE type string', async () => {
    expect(typeof signQuote).toBe('function')
    expect(SIGNED_QUOTE_TYPE_STRING).toContain('SignedQuote(address mm,bytes32 marketId')
  })
})
