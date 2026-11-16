import { describe, it, expect } from 'vitest'
import { computeTripPermissions } from './useTripPermissions'

const base = { userId: 'u1', tripCreatedBy: 'someone', participantRole: 'participant' as const, isSiteAdmin: false }

describe('computeTripPermissions', () => {
  it('plain participant cannot manage', () => {
    expect(computeTripPermissions(base).canManageTrip).toBe(false)
  })
  it('active organiser can manage', () => {
    const p = computeTripPermissions({ ...base, participantRole: 'organizer' })
    expect(p.isTripOrganizer).toBe(true)
    expect(p.canManageTrip).toBe(true)
  })
  it('trip creator who is not on the roster can manage', () => {
    const p = computeTripPermissions({ ...base, participantRole: null, tripCreatedBy: 'u1' })
    expect(p.isTripCreator).toBe(true)
    expect(p.canManageTrip).toBe(true)
  })
  it('site admin who is not on the trip can manage', () => {
    expect(computeTripPermissions({ ...base, participantRole: undefined, isSiteAdmin: true }).canManageTrip).toBe(true)
  })
  it('signed-out or unknown creator never manages', () => {
    expect(computeTripPermissions({ ...base, userId: undefined, tripCreatedBy: undefined, participantRole: null }).canManageTrip).toBe(false)
    expect(computeTripPermissions({ ...base, userId: undefined, tripCreatedBy: null, participantRole: null }).isTripCreator).toBe(false)
  })
})
