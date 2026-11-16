import { describe, expect, it } from 'vitest'
import { readEventCost } from '../../../lib/cost/yourCost'
import { applyEventCost, costFormFromEvent, validateEventCost } from './eventCostForm'

describe('event cost form', () => {
  it('blank when no cost, with fallback currency', () => {
    expect(costFormFromEvent({}, 'EUR')).toEqual({ costAmount: '', costCurrency: 'EUR', costBasis: 'each' })
  })
  it.each(['each', 'total_split'] as const)('round-trips %s and keeps other keys', (basis) => {
    const meta = applyEventCost({ booking_ref: 'X1' }, { costAmount: '40.5', costCurrency: 'GBP', costBasis: basis })
    expect(readEventCost(meta)).toEqual({ amount: 40.5, currency: 'GBP', basis })
    expect((meta as Record<string, unknown>).booking_ref).toBe('X1')
    expect(costFormFromEvent(meta, 'EUR')).toEqual({ costAmount: '40.5', costCurrency: 'GBP', costBasis: basis })
  })
  it('clearing the amount removes the cost', () => {
    const had = applyEventCost(null, { costAmount: '10', costCurrency: 'GBP', costBasis: 'each' })
    const meta = applyEventCost(had, { costAmount: '', costCurrency: 'GBP', costBasis: 'each' })
    expect(readEventCost(meta)).toBeNull()
  })
  it('validates', () => {
    expect(validateEventCost({ costAmount: '', costCurrency: 'GBP', costBasis: 'each' })).toBeNull()
    expect(validateEventCost({ costAmount: '-1', costCurrency: 'GBP', costBasis: 'each' })).toMatch(/negative/)
  })
})
