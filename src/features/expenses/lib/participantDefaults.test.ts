import { describe, it, expect } from 'vitest'
import { defaultTaggedParticipantIds, defaultTaggedParticipants } from './participantDefaults'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'

function fixture(userId: string, confirmationStatus: string): ParticipantWithUser {
  return { user_id: userId, confirmation_status: confirmationStatus } as unknown as ParticipantWithUser
}

describe('defaultTaggedParticipantIds', () => {
  it('defaults to confirmed participants only', () => {
    const participants = [fixture('a', 'confirmed'), fixture('b', 'pending'), fixture('c', 'confirmed'), fixture('d', 'declined')]
    expect(defaultTaggedParticipantIds(participants)).toEqual(['a', 'c'])
  })

  it('falls back to everyone when nobody has confirmed yet', () => {
    const participants = [fixture('a', 'pending'), fixture('b', 'interested')]
    expect(defaultTaggedParticipantIds(participants)).toEqual(['a', 'b'])
  })

  it('excludes declined/cancelled participants once at least one person is confirmed', () => {
    const participants = [fixture('a', 'confirmed'), fixture('b', 'declined'), fixture('c', 'cancelled')]
    expect(defaultTaggedParticipantIds(participants)).toEqual(['a'])
  })

  it('returns an empty list for an empty trip', () => {
    expect(defaultTaggedParticipantIds([])).toEqual([])
  })

  it('defaultTaggedParticipants mirrors the id-only helper', () => {
    const participants = [fixture('a', 'confirmed'), fixture('b', 'pending')]
    expect(defaultTaggedParticipants(participants).map((p) => p.user_id)).toEqual(['a'])
  })
})
