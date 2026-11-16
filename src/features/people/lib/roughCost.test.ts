import { describe, expect, it } from 'vitest'
import { buildRsvpCostLine } from './roughCost'

describe('buildRsvpCostLine', () => {
  const trip = { estimated_accommodation_cost: 500, accommodation_cost_currency: 'GBP' }
  it('prefers the Your cost figure', () => {
    expect(buildRsvpCostLine(trip, '≈£400 – £580')).toMatchObject({ source: 'your_cost', figure: '≈£400 – £580' })
  })
  it('falls back to the organizer estimate, via the one formatter, labelled as an estimate', () => {
    const l = buildRsvpCostLine(trip, null)!
    expect(l.source).toBe('organizer')
    expect(l.figure).toBe('≈£500 per person')
    expect(l.note).toMatch(/estimate/)
    expect(l.figure).not.toMatch(/GBP/)
  })
  it('null when nothing is known', () => {
    expect(buildRsvpCostLine({ estimated_accommodation_cost: null }, '')).toBeNull()
    expect(buildRsvpCostLine(null)).toBeNull()
  })
})
