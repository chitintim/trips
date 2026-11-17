import { describe, expect, it } from 'vitest'
import { canEditItems, editExpenseUrl, moneySpaceUrl, unassignedPrompt } from './claimDone'

describe('unassignedPrompt', () => {
  it('asks plainly about one item and says who it sits with', () => {
    const p = unassignedPrompt({ count: 1, minor: 400, currency: 'GBP', payerName: 'Sam', viewerIsPayer: false })
    expect(p?.title).toMatch(/^1 item \(£4\.00\) isn't assigned yet$/)
    expect(p?.body).toBe('Until it is placed, it stays with Sam.')
  })
  it('plural, and "you" for the payer', () => {
    const p = unassignedPrompt({ count: 3, minor: 1250, currency: 'GBP', payerName: 'Sam', viewerIsPayer: true })
    expect(p?.title).toBe("3 items (£12.50) aren't assigned yet")
    expect(p?.body).toBe('Until they are placed, they stay with you.')
  })
  it('nothing to ask when everything is assigned', () => {
    expect(unassignedPrompt({ count: 0, minor: 0, currency: 'GBP', payerName: 'Sam', viewerIsPayer: true })).toBeNull()
  })
})

describe('moneySpaceUrl', () => {
  it('opens the trip on Money', () => {
    expect(moneySpaceUrl('abc-1')).toBe('/abc-1?tab=money')
  })
})

describe('editExpenseUrl / canEditItems', () => {
  it('opens the expense editor from the Money space', () => {
    expect(editExpenseUrl('t1', 'e 2')).toBe('/t1?tab=money&editExpense=e%202')
  })
  it('allows the payer or a manager, but not when frozen or closed', () => {
    expect(canEditItems({ isPayer: true, canManageTrip: false, frozen: false, closed: false })).toBe(true)
    expect(canEditItems({ isPayer: false, canManageTrip: true, frozen: false, closed: false })).toBe(true)
    expect(canEditItems({ isPayer: false, canManageTrip: false, frozen: false, closed: false })).toBe(false)
    expect(canEditItems({ isPayer: true, canManageTrip: true, frozen: true, closed: false })).toBe(false)
    expect(canEditItems({ isPayer: true, canManageTrip: true, frozen: false, closed: true })).toBe(false)
  })
})
