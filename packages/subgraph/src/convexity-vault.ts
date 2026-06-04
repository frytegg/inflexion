/**
 * ConvexityVault mappings — DEP-8/DEP-9 + PUB-2: per-depositor flow + the pooled
 * NAV / util / premium time series (claim B: capital not guaranteed). Maintains a
 * running PoolState and checkpoints it into PoolDaySnapshot / PoolHourSnapshot.
 *
 * NAV per tranche is reconstructed from the cash flows: deposits/withdrawals move
 * principal; PremiumAccrued credits each tranche; JuniorLoss debits junior first,
 * then senior. utilWad = totalLocked / (seniorAssets + juniorAssets).
 */
import { BigInt, Bytes } from '@graphprotocol/graph-ts'
import {
  Deposited,
  WithdrawRequested,
  Withdrawn,
  PremiumAccrued,
  CollateralLocked,
  SettlementReleased,
  JuniorLoss,
} from '../generated/ConvexityVault/ConvexityVault'
import { Depositor, PoolDaySnapshot, PoolHourSnapshot } from '../generated/schema'
import { getPoolState } from './entities'
import {
  ZERO_BI,
  WAD,
  SECONDS_PER_DAY,
  SECONDS_PER_HOUR,
  TRANCHE_SENIOR,
  TRANCHE_JUNIOR,
  depositorId,
} from './helpers'

function getDepositor(addrHex: string, addr: Bytes, tranche: i32, ts: BigInt): Depositor {
  let d = Depositor.load(addrHex)
  if (d == null) {
    d = new Depositor(addrHex)
    d.address = addr
    d.tranche = tranche
    d.shares = ZERO_BI
    d.totalDeposited = ZERO_BI
    d.totalWithdrawn = ZERO_BI
    d.pendingWithdrawShares = ZERO_BI
    d.pendingUnlockAt = null
    d.firstSeen = ts
    d.lastUpdated = ts
  }
  return d
}

function utilWad(totalLocked: BigInt, seniorAssets: BigInt, juniorAssets: BigInt): BigInt {
  const nav = seniorAssets.plus(juniorAssets)
  if (nav.le(ZERO_BI)) return ZERO_BI
  return totalLocked.times(WAD).div(nav)
}

/** Checkpoint the running PoolState into the current day + hour snapshots. */
function checkpoint(ts: BigInt): void {
  const ps = getPoolState(ts)
  const util = utilWad(ps.totalLocked, ps.seniorAssets, ps.juniorAssets)

  const dayId = ts.div(SECONDS_PER_DAY).toString()
  let day = PoolDaySnapshot.load(dayId)
  if (day == null) {
    day = new PoolDaySnapshot(dayId)
    day.dayStart = ts.div(SECONDS_PER_DAY).times(SECONDS_PER_DAY)
    day.premiumAccrued = ZERO_BI
    day.payouts = ZERO_BI
    day.juniorLoss = ZERO_BI
    day.seniorLoss = ZERO_BI
  }
  day.seniorAssets = ps.seniorAssets
  day.juniorAssets = ps.juniorAssets
  day.totalLocked = ps.totalLocked
  day.utilWad = util
  day.concWad = ps.concWad
  day.save()

  const hourId = ts.div(SECONDS_PER_HOUR).toString()
  let hour = PoolHourSnapshot.load(hourId)
  if (hour == null) {
    hour = new PoolHourSnapshot(hourId)
    hour.hourStart = ts.div(SECONDS_PER_HOUR).times(SECONDS_PER_HOUR)
    hour.premiumAccrued = ZERO_BI
    hour.payouts = ZERO_BI
    hour.juniorLoss = ZERO_BI
    hour.seniorLoss = ZERO_BI
  }
  hour.seniorAssets = ps.seniorAssets
  hour.juniorAssets = ps.juniorAssets
  hour.totalLocked = ps.totalLocked
  hour.utilWad = util
  hour.concWad = ps.concWad
  hour.save()
}

/** Add a flow delta to the current day + hour snapshots (premium/payout/loss). */
function addFlow(
  ts: BigInt,
  premium: BigInt,
  payout: BigInt,
  juniorLoss: BigInt,
  seniorLoss: BigInt,
): void {
  const dayId = ts.div(SECONDS_PER_DAY).toString()
  let day = PoolDaySnapshot.load(dayId)
  if (day != null) {
    day.premiumAccrued = day.premiumAccrued.plus(premium)
    day.payouts = day.payouts.plus(payout)
    day.juniorLoss = day.juniorLoss.plus(juniorLoss)
    day.seniorLoss = day.seniorLoss.plus(seniorLoss)
    day.save()
  }
  const hourId = ts.div(SECONDS_PER_HOUR).toString()
  let hour = PoolHourSnapshot.load(hourId)
  if (hour != null) {
    hour.premiumAccrued = hour.premiumAccrued.plus(premium)
    hour.payouts = hour.payouts.plus(payout)
    hour.juniorLoss = hour.juniorLoss.plus(juniorLoss)
    hour.seniorLoss = hour.seniorLoss.plus(seniorLoss)
    hour.save()
  }
}

export function handleDeposited(event: Deposited): void {
  const tranche = event.params.tranche
  const id = depositorId(event.params.who, tranche)
  const d = getDepositor(id, event.params.who, tranche, event.block.timestamp)
  d.shares = d.shares.plus(event.params.shares)
  d.totalDeposited = d.totalDeposited.plus(event.params.assets)
  d.lastUpdated = event.block.timestamp
  d.save()

  const ps = getPoolState(event.block.timestamp)
  if (tranche == TRANCHE_JUNIOR) {
    ps.juniorAssets = ps.juniorAssets.plus(event.params.assets)
  } else {
    ps.seniorAssets = ps.seniorAssets.plus(event.params.assets)
  }
  ps.lastUpdated = event.block.timestamp
  ps.save()
  checkpoint(event.block.timestamp)
}

export function handleWithdrawRequested(event: WithdrawRequested): void {
  const id = depositorId(event.params.who, event.params.tranche)
  const d = getDepositor(id, event.params.who, event.params.tranche, event.block.timestamp)
  d.pendingWithdrawShares = event.params.shares
  d.pendingUnlockAt = event.params.unlockAt
  d.lastUpdated = event.block.timestamp
  d.save()
}

export function handleWithdrawn(event: Withdrawn): void {
  const tranche = event.params.tranche
  const id = depositorId(event.params.who, tranche)
  const d = getDepositor(id, event.params.who, tranche, event.block.timestamp)
  d.shares = d.shares.gt(event.params.shares) ? d.shares.minus(event.params.shares) : ZERO_BI
  d.totalWithdrawn = d.totalWithdrawn.plus(event.params.assets)
  d.pendingWithdrawShares = ZERO_BI
  d.pendingUnlockAt = null
  d.lastUpdated = event.block.timestamp
  d.save()

  const ps = getPoolState(event.block.timestamp)
  if (tranche == TRANCHE_JUNIOR) {
    ps.juniorAssets = ps.juniorAssets.gt(event.params.assets)
      ? ps.juniorAssets.minus(event.params.assets)
      : ZERO_BI
  } else {
    ps.seniorAssets = ps.seniorAssets.gt(event.params.assets)
      ? ps.seniorAssets.minus(event.params.assets)
      : ZERO_BI
  }
  ps.lastUpdated = event.block.timestamp
  ps.save()
  checkpoint(event.block.timestamp)
}

export function handlePremiumAccrued(event: PremiumAccrued): void {
  const ps = getPoolState(event.block.timestamp)
  ps.seniorAssets = ps.seniorAssets.plus(event.params.toSenior)
  ps.juniorAssets = ps.juniorAssets.plus(event.params.toJunior)
  ps.cumulativePremiumAccrued = ps.cumulativePremiumAccrued.plus(event.params.amount)
  ps.lastUpdated = event.block.timestamp
  ps.save()
  checkpoint(event.block.timestamp)
  addFlow(event.block.timestamp, event.params.amount, ZERO_BI, ZERO_BI, ZERO_BI)
}

export function handleCollateralLocked(event: CollateralLocked): void {
  const ps = getPoolState(event.block.timestamp)
  ps.totalLocked = event.params.totalLocked
  ps.lastUpdated = event.block.timestamp
  ps.save()
  checkpoint(event.block.timestamp)
}

export function handleSettlementReleased(event: SettlementReleased): void {
  const ps = getPoolState(event.block.timestamp)
  // `unlocked` is the collateral returned to the free pool; reduce totalLocked.
  ps.totalLocked = ps.totalLocked.gt(event.params.unlocked)
    ? ps.totalLocked.minus(event.params.unlocked)
    : ZERO_BI
  ps.cumulativePayouts = ps.cumulativePayouts.plus(event.params.payout)
  ps.lastUpdated = event.block.timestamp
  ps.save()
  checkpoint(event.block.timestamp)
  addFlow(event.block.timestamp, ZERO_BI, event.params.payout, ZERO_BI, ZERO_BI)
}

export function handleJuniorLoss(event: JuniorLoss): void {
  const ps = getPoolState(event.block.timestamp)
  // Loss is absorbed by junior first, then senior (first-loss tranche order).
  ps.juniorAssets = ps.juniorAssets.gt(event.params.juniorLoss)
    ? ps.juniorAssets.minus(event.params.juniorLoss)
    : ZERO_BI
  ps.seniorAssets = ps.seniorAssets.gt(event.params.seniorLoss)
    ? ps.seniorAssets.minus(event.params.seniorLoss)
    : ZERO_BI
  ps.cumulativeJuniorLoss = ps.cumulativeJuniorLoss.plus(event.params.juniorLoss)
  ps.cumulativeSeniorLoss = ps.cumulativeSeniorLoss.plus(event.params.seniorLoss)
  ps.lastUpdated = event.block.timestamp
  ps.save()
  checkpoint(event.block.timestamp)
  addFlow(event.block.timestamp, ZERO_BI, ZERO_BI, event.params.juniorLoss, event.params.seniorLoss)
}
