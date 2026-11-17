import { describe, it, expect } from 'vitest'
import {
  applyChoiceToAll,
  choiceIsComplete,
  coverChoiceLabel,
  freezeGate,
  isUnclaimedReceiptsError,
  notClaimedLine,
  planApplication,
  receiptsForNotice,
  summariseApplication,
} from './unclaimedReceipts'
import type { ReceiptClaimStatus } from '../lib/balances'

function r(id: string, paidBy: string, shortfall: number, currency = 'EUR'): ReceiptClaimStatus {
  return {
    expenseId: id, description: `Dinner ${id}`, paidBy, currency, claimCode: null, totalMinor: 10000, claimedMinor: 10000 - shortfall,
    leftoverClaimedMinor: 0, pendingMinor: shortfall, unclaimedMinor: shortfall, dustMinor: 0, unclaimedOwnMinor: shortfall, shortfallOwnMinor: shortfall, openDiscountOwnMinor: 0,
  }
}

describe('notice', () => {
  it('prints "<receipt> — €48.00 not claimed" in the receipt\'s own currency', () => {
    expect(notClaimedLine(r('X', 'a', 4800))).toBe('Dinner X — €48.00 not claimed')
    expect(notClaimedLine({ ...r('X', 'a', 3000), currency: 'JPY' })).toBe('Dinner X — ¥3,000 not claimed')
  })

  it('managers see every receipt, payers only their own, others nothing', () => {
    const list = [r('1', 'a', 100), r('2', 'b', 200)]
    expect(receiptsForNotice(list, 'z', true)).toHaveLength(2)
    expect(receiptsForNotice(list, 'a', false).map((x) => x.expenseId)).toEqual(['1'])
    expect(receiptsForNotice(list, 'z', false)).toEqual([])
    expect(receiptsForNotice(list, undefined, false)).toEqual([])
  })
})

describe('freezeGate', () => {
  it('opens the dialog while receipts have unclaimed value and the leftovers function is live', () => {
    expect(freezeGate([r('1', 'a', 100)], true)).toEqual({ kind: 'dialog', receipts: [r('1', 'a', 100)] })
  })
  it('proceeds when nothing is unclaimed', () => {
    expect(freezeGate([], true)).toEqual({ kind: 'proceed' })
  })
  it('fails soft: proceeds when the leftovers function is not live yet', () => {
    expect(freezeGate([r('1', 'a', 100)], false)).toEqual({ kind: 'proceed' })
  })
})

describe('isUnclaimedReceiptsError', () => {
  it('reads the hint or the server wording', () => {
    expect(isUnclaimedReceiptsError(Object.assign(new Error('x'), { hint: 'unclaimed_receipts' }))).toBe(true)
    expect(isUnclaimedReceiptsError(new Error('2 receipts still have unclaimed items. Share or assign the leftovers first, then freeze.'))).toBe(true)
    expect(isUnclaimedReceiptsError(new Error('Payments changed while you were freezing'))).toBe(false)
    expect(isUnclaimedReceiptsError(null)).toBe(false)
  })
})

describe('choices', () => {
  const list = [r('1', 'a', 100), r('2', 'b', 200)]
  it('a person choice needs a person', () => {
    expect(choiceIsComplete({ mode: 'person' })).toBe(false)
    expect(choiceIsComplete({ mode: 'person', userId: 'u' })).toBe(true)
    expect(choiceIsComplete({ mode: 'everyone' })).toBe(true)
    expect(choiceIsComplete(undefined)).toBe(false)
  })
  it('apply to all sets every receipt; a person is skipped where they are not on the receipt', () => {
    expect(Object.keys(applyChoiceToAll(list, { mode: 'everyone' }))).toEqual(['1', '2'])
    const out = applyChoiceToAll(list, { mode: 'person', userId: 'u' }, (id) => id === '1')
    expect(Object.keys(out)).toEqual(['1'])
  })
  it('plans one call per receipt and reports the receipts still missing a choice', () => {
    const plan = planApplication(list, { '1': { mode: 'payer' }, '2': { mode: 'person' } })
    expect(plan.steps).toEqual([{ expenseId: '1', currency: 'EUR', mode: 'payer', userId: null }])
    expect(plan.missing).toEqual(['2'])
    const full = planApplication(list, { '1': { mode: 'everyone' }, '2': { mode: 'person', userId: 'u' } })
    expect(full.steps.map((s) => [s.mode, s.userId])).toEqual([['everyone', null], ['person', 'u']])
    expect(full.missing).toEqual([])
  })
  it('summarises partial failures', () => {
    expect(summariseApplication({ done: ['1'], failed: [] }, 1).tone).toBe('success')
    expect(summariseApplication({ done: ['1'], failed: [{ expenseId: '2', message: 'x' }] }, 2).tone).toBe('warning')
    expect(summariseApplication({ done: [], failed: [{ expenseId: '2', message: 'x' }] }, 1).tone).toBe('error')
  })
  it('words the payer\'s own choice in the first person', () => {
    expect(coverChoiceLabel('a', 'a', 'Tim')).toBe("I'll cover it")
    expect(coverChoiceLabel('z', 'a', 'Tim')).toBe('Tim covers it')
  })
})
