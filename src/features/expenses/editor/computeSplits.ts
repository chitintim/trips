/**
 * Pure split computation for the expense editor's split step. All modes
 * funnel through largestRemainderDistribute so splits always sum EXACTLY
 * to the expense amount (plan §10: "All split math via
 * largestRemainderDistribute -- splits MUST sum exactly to amount"), fixing
 * v1's AddExpenseModal bug where equal splits left raw repeating decimals
 * with nothing absorbing the rounding remainder.
 */
import { toMinorUnits, fromMinorUnits, largestRemainderDistribute } from '../../../lib/money'
import { computeNightsWeights, nightsWeightsToWeightArray } from '../lib/nightsWeighting'
import type { TimelineEvent } from '../../../types'
import type { SplitEntry } from './wizardState'
import type { SplitMode } from '../types'

export interface ComputedSplit {
  userId: string
  amountMajor: number
  percentage: number | null
  shares: number | null
}

export interface ComputeSplitsInput {
  mode: SplitMode
  amountMajor: number
  currency: string
  participantIds: string[]
  entries: SplitEntry[]
  /** Only used for mode 'nights' resolution upstream (accommodation weight-by-nights one-tap sets mode to 'shares' with these weights pre-filled) -- kept separate so this function stays pure/synchronous. */
  nightsContext?: {
    events: TimelineEvent[]
    tripStartDate: string
    tripEndDate: string
  }
}

function parseEntryValue(entries: SplitEntry[], userId: string): number {
  const entry = entries.find((e) => e.userId === userId)
  const parsed = parseFloat(entry?.value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Computes final per-participant splits for equal/custom/percentage/shares
 * modes. 'itemized' is NOT handled here -- itemized expenses have no
 * expense_splits rows; they use line items + claims instead (see
 * itemized/ module).
 */
export function computeSplits(input: ComputeSplitsInput): ComputedSplit[] {
  const { mode, amountMajor, currency, participantIds } = input
  const totalMinor = toMinorUnits(amountMajor, currency)

  if (participantIds.length === 0) return []

  if (mode === 'equal') {
    const shares = largestRemainderDistribute(totalMinor, participantIds.map(() => 1))
    return participantIds.map((userId, i) => ({
      userId,
      amountMajor: fromMinorUnits(shares[i], currency),
      percentage: null,
      shares: null,
    }))
  }

  if (mode === 'shares') {
    const weights = participantIds.map((userId) => {
      const w = parseEntryValue(input.entries, userId)
      return w > 0 ? w : 1 // default weight 1 if unset/invalid
    })
    const shares = largestRemainderDistribute(totalMinor, weights)
    return participantIds.map((userId, i) => ({
      userId,
      amountMajor: fromMinorUnits(shares[i], currency),
      percentage: null,
      shares: weights[i],
    }))
  }

  if (mode === 'percentage') {
    // Percentages are user-entered and should sum to 100 (validated by the
    // caller/UI before advancing), but we still route the actual money
    // split through largestRemainderDistribute using the percentages as
    // weights so the amounts always sum exactly to the total regardless of
    // rounding in the entered percentages themselves.
    const percents = participantIds.map((userId) => Math.max(0, parseEntryValue(input.entries, userId)))
    const shares = largestRemainderDistribute(totalMinor, percents)
    return participantIds.map((userId, i) => ({
      userId,
      amountMajor: fromMinorUnits(shares[i], currency),
      percentage: percents[i],
      shares: null,
    }))
  }

  // mode === 'custom': user-entered exact amounts. These are NOT
  // redistributed (the user's explicit numbers are authoritative) but are
  // still validated to sum to the total by the caller before advancing;
  // this function just converts each entry to a clean amount.
  return participantIds.map((userId) => ({
    userId,
    amountMajor: parseEntryValue(input.entries, userId),
    percentage: null,
    shares: null,
  }))
}

export interface CustomSplitValidation {
  isValid: boolean
  sumMajor: number
  targetMajor: number
  deltaMajor: number
}

/** Validates that custom/percentage entries sum to the expected target (amount for custom, 100 for percentage), using minor-unit integer comparison to avoid float epsilon issues. */
export function validateSplitSum(
  mode: 'custom' | 'percentage',
  entries: SplitEntry[],
  participantIds: string[],
  amountMajor: number,
  currency: string
): CustomSplitValidation {
  if (mode === 'percentage') {
    const sum = participantIds.reduce((acc, id) => acc + Math.max(0, parseEntryValue(entries, id)), 0)
    const rounded = Math.round(sum * 100) / 100
    return { isValid: Math.abs(rounded - 100) < 0.01, sumMajor: rounded, targetMajor: 100, deltaMajor: rounded - 100 }
  }

  const sumMinor = toMinorUnits(
    participantIds.reduce((acc, id) => acc + parseEntryValue(entries, id), 0),
    currency
  )
  const targetMinor = toMinorUnits(amountMajor, currency)
  return {
    isValid: sumMinor === targetMinor,
    sumMajor: fromMinorUnits(sumMinor, currency),
    targetMajor: fromMinorUnits(targetMinor, currency),
    deltaMajor: fromMinorUnits(sumMinor - targetMinor, currency),
  }
}

/**
 * One-tap "weight by nights present" (plan §10, accommodation only):
 * computes nights-based share entries for the given participants, ready to
 * drop straight into split mode 'shares'.
 */
export function computeNightsWeightSplitEntries(
  participantIds: string[],
  events: TimelineEvent[],
  tripStartDate: string,
  tripEndDate: string
): SplitEntry[] {
  const results = computeNightsWeights(participantIds, events, tripStartDate, tripEndDate)
  const weights = nightsWeightsToWeightArray(results)
  return participantIds.map((userId, i) => ({ userId, value: String(weights[i]) }))
}
