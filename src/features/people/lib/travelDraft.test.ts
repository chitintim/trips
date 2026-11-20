import { describe, it, expect } from 'vitest'
import type { TimelineEvent } from '../../../types'
import { decideTravelSeed, travelFingerprint } from './travelDraft'

const row = (id: string, updated_at: string, ids = ['sam']) =>
  ({ id, updated_at, participant_ids: ids, source_option_id: null, metadata: { travel_details: true, direction: 'arrival' } }) as unknown as TimelineEvent

describe('decideTravelSeed', () => {
  it('ignores an empty auto-saved draft', () => {
    expect(decideTravelSeed({ basedOn: 'a@1' }, 'a@1', false)).toBe('live')
  })
  it('discards a draft built on travel that has since changed', () => {
    expect(decideTravelSeed({ basedOn: 'a@1' }, 'a@2', true)).toBe('live')
  })
  it('restores a fresh draft that really differs', () => {
    expect(decideTravelSeed({ basedOn: 'a@1' }, 'a@1', true)).toBe('draft')
  })
  it('restores a real draft when nothing was saved yet', () => {
    expect(decideTravelSeed({ basedOn: '' }, '', true)).toBe('draft')
  })
  it('seeds from live when there is no draft', () => {
    expect(decideTravelSeed(null, '', false)).toBe('live')
  })
})

describe('travelFingerprint', () => {
  it('is order independent and counts only strictly own rows', () => {
    const a = travelFingerprint([row('b', '2'), row('a', '1'), row('shared', '3', ['sam', 'kim'])], 'sam')
    expect(a).toBe('a@1|b@2')
    expect(travelFingerprint([row('a', '1'), row('b', '2')], 'sam')).toBe(a)
    expect(travelFingerprint([row('a', '9')], 'sam')).not.toBe('a@1')
  })
})
