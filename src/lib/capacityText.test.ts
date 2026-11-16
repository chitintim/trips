import { describe, expect, it } from 'vitest'
import { capacityLine, dashboardCapacityLabel, invitedOverCapacityNote } from './capacityText'

describe('capacityText', () => {
  it('reads plainly', () => {
    expect(capacityLine(1, 8)).toBe('1 of 8 places taken · 7 left')
    expect(capacityLine(8, 8)).toBe('8 of 8 places taken · Full')
    expect(capacityLine(3, null)).toBe('3 going · No limit')
  })
  it('notes over-invited trips only', () => {
    expect(invitedOverCapacityNote(9, 8)).toBe('9 invited for 8 places')
    expect(invitedOverCapacityNote(8, 8)).toBeNull()
    expect(invitedOverCapacityNote(9, null)).toBeNull()
    expect(invitedOverCapacityNote(undefined, 8)).toBeNull()
  })
  it('dashboard label', () => {
    expect(dashboardCapacityLabel(1, 8)).toBe('1 going · 8 places')
    expect(dashboardCapacityLabel(2, null)).toBe('2 going')
  })
})
