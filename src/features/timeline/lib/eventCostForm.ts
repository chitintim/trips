/**
 * Event editor cost field <-> `trip_timeline_events.metadata.cost`
 * (via the frozen readEventCost / withEventCost). Pure and tested.
 */
import { readEventCost, withEventCost, type EventCost } from '../../../lib/cost/yourCost'
import type { Json } from '../../../types/database.types'

export type EventCostBasis = EventCost['basis']

export const EVENT_COST_BASES: ReadonlyArray<{ value: EventCostBasis; label: string }> = [
  { value: 'each', label: 'Each person pays' },
  { value: 'total_split', label: 'One price, split between everyone going' },
]

export interface EventCostFormValues {
  costAmount: string
  costCurrency: string
  costBasis: EventCostBasis
}

export function costFormFromEvent(metadata: Json | null | undefined, fallbackCurrency: string): EventCostFormValues {
  const cost = readEventCost(metadata)
  return cost
    ? { costAmount: String(cost.amount), costCurrency: cost.currency, costBasis: cost.basis }
    : { costAmount: '', costCurrency: fallbackCurrency, costBasis: 'each' }
}

/** A message when the amount is unusable, else null. Blank is fine (no cost). */
export function validateEventCost(v: EventCostFormValues): string | null {
  if (v.costAmount.trim() === '') return null
  const n = Number(v.costAmount)
  if (!Number.isFinite(n)) return 'Enter the cost as a number.'
  if (n < 0) return 'The cost can’t be negative.'
  return null
}

/** New metadata for the event: `cost` set (positive amount) or removed (blank / 0); other keys kept. */
export function applyEventCost(existing: Json | null | undefined, v: EventCostFormValues): Json {
  const n = v.costAmount.trim() === '' ? 0 : Number(v.costAmount)
  return withEventCost(existing, n > 0 && Number.isFinite(n) ? { amount: n, currency: v.costCurrency, basis: v.costBasis } : null)
}
