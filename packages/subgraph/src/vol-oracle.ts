/**
 * VolOracle mappings — the σ_ref EWMA series (SigmaPoint). σ_ref = the conservative
 * max over the short/long EWMA windows and the floor (the contract's _sigmaRef);
 * we record both annualised windows and carry the binding σ_ref forward.
 *
 * GAP-FILL: `poke` is a no-op (emits NO Poked) when dt < minSampleInterval. The
 * σ_ref series therefore has holes between pokes on quiet feeds; the InflexionCore
 * mapping backfills them from SwapPriced.sigmaRefWad (source = SWAP_PRICED_BACKFILL),
 * so a downstream consumer sees a continuous series.
 */
import { BigInt } from '@graphprotocol/graph-ts'
import { Poked, Initialized } from '../generated/VolOracle/VolOracle'
import { SigmaPoint } from '../generated/schema'
import { eventUid } from './helpers'

/** σ_ref the contract would report = max(short, long). The contract binds the most
 *  conservative window; from a Poked event we have the short+long annualised σ and
 *  reconstruct the reported σ_ref as their max (matches the EWMA "max window binds"
 *  semantics; the floor binds at INITIALIZED, recorded separately). */
function reportedSigmaRef(sigmaShort: BigInt, sigmaLong: BigInt): BigInt {
  return sigmaShort.gt(sigmaLong) ? sigmaShort : sigmaLong
}

export function handlePoked(event: Poked): void {
  const sp = new SigmaPoint(eventUid(event))
  sp.token = event.params.token
  sp.timestamp = event.block.timestamp
  sp.blockNumber = event.block.number
  sp.priceWad = event.params.priceWad
  sp.dtSeconds = event.params.dtSeconds
  sp.sigmaShortWad = event.params.sigmaShortWad
  sp.sigmaLongWad = event.params.sigmaLongWad
  sp.sigmaRefWad = reportedSigmaRef(event.params.sigmaShortWad, event.params.sigmaLongWad)
  sp.source = 'POKE'
  sp.save()
}

export function handleInitialized(event: Initialized): void {
  const sp = new SigmaPoint(eventUid(event))
  sp.token = event.params.token
  sp.timestamp = event.block.timestamp
  sp.blockNumber = event.block.number
  sp.priceWad = event.params.priceWad
  // At init both windows seed at the floor → σ_ref starts at the floor.
  sp.sigmaRefWad = event.params.floorWad
  sp.source = 'INITIALIZED'
  sp.save()
}
