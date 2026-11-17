import { describe, it, expect } from 'vitest'
import { buildSplitRows, buildExpensePayload, buildItemizedExpensePayload, buildItemizedHeaderEditPayload } from './expenseSavePayload'
import { emptyWizardDraft, draftFromExpense, seedParticipantIds, participantSelectionChanged, draftFromParsedReceipt, type ExpenseWizardDraft } from './wizardState'
import type { ParsedReceiptData } from '../../../lib/receiptParsing'
import type { ExpenseFxFields } from '../../../lib/fx/resolveExpenseFxFields'

/**
 * Characterisation of the rows the old four-step wizard saved. Expected values
 * are pinned literals (derived from the old handleSubmit), so the one-screen
 * form must keep producing exactly these.
 */
const NO_FX: ExpenseFxFields = { fx_rate: null, fx_rate_date: null, base_currency_amount: null, rate_source: null }
const ids = ['u1', 'u2', 'u3']
const base = (patch: Partial<ExpenseWizardDraft>): ExpenseWizardDraft => ({
  ...emptyWizardDraft({ today: '2026-11-17', baseCurrency: 'GBP', currentUserId: 'u1', allParticipantIds: ids }),
  description: ' Dinner ',
  amount: '60',
  ...patch,
})

describe('expense save payload (characterisation)', () => {
  it('equal split', () => {
    const d = base({})
    expect(buildExpensePayload(d, 60, null, NO_FX)).toEqual({
      description: 'Dinner', amount: 60, currency: 'GBP', category: 'other', vendor_name: null, payment_date: '2026-11-17',
      paid_by: 'u1', participant_ids: ids, receipt_url: null, fx_rate: null, fx_rate_date: null, base_currency_amount: null, rate_source: null,
    })
    expect(buildSplitRows(d, 60, NO_FX)).toEqual(
      ids.map((u) => ({ user_id: u, amount: 20, split_type: 'equal', percentage: null, shares: null, base_currency_amount: null }))
    )
  })

  it('equal split with a remainder gives the odd penny to the first person', () => {
    const rows = buildSplitRows(base({ amount: '10' }), 10, NO_FX)
    expect(rows.map((r) => r.amount)).toEqual([3.34, 3.33, 3.33])
  })

  it('custom split', () => {
    const d = base({ splitMode: 'custom', splitEntries: [{ userId: 'u1', value: '30' }, { userId: 'u2', value: '20' }, { userId: 'u3', value: '10' }] })
    expect(buildSplitRows(d, 60, NO_FX).map((r) => [r.user_id, r.amount, r.split_type])).toEqual([['u1', 30, 'custom'], ['u2', 20, 'custom'], ['u3', 10, 'custom']])
  })

  it('percentage split', () => {
    const d = base({ splitMode: 'percentage', splitEntries: [{ userId: 'u1', value: '50' }, { userId: 'u2', value: '25' }, { userId: 'u3', value: '25' }] })
    const rows = buildSplitRows(d, 60, NO_FX)
    expect(rows.map((r) => [r.amount, r.split_type, r.percentage])).toEqual([[30, 'percentage', 50], [15, 'percentage', 25], [15, 'percentage', 25]])
  })

  it('shares split', () => {
    const d = base({ splitMode: 'shares', splitEntries: [{ userId: 'u1', value: '2' }, { userId: 'u2', value: '1' }, { userId: 'u3', value: '1' }] })
    const rows = buildSplitRows(d, 60, NO_FX)
    expect(rows.map((r) => [r.amount, r.split_type, r.shares])).toEqual([[30, 'shares', 2], [15, 'shares', 1], [15, 'shares', 1]])
  })

  it('foreign currency with an fx rate carries base-currency amounts on expense and splits', () => {
    const fx: ExpenseFxFields = { fx_rate: 0.5, fx_rate_date: '2026-11-17', base_currency_amount: 30, rate_source: 'ecb' }
    const d = base({ currency: 'EUR' })
    expect(buildExpensePayload(d, 60, 'u1/r.jpg', fx)).toMatchObject({ currency: 'EUR', receipt_url: 'u1/r.jpg', fx_rate: 0.5, fx_rate_date: '2026-11-17', base_currency_amount: 30, rate_source: 'ecb' })
    expect(buildSplitRows(d, 60, fx).map((r) => r.base_currency_amount)).toEqual([10, 10, 10])
  })

  it('manual rate keeps rate_source manual', () => {
    const fx: ExpenseFxFields = { fx_rate: 0.8, fx_rate_date: null, base_currency_amount: 48, rate_source: 'manual' }
    expect(buildExpensePayload(base({ currency: 'EUR' }), 60, null, fx)).toMatchObject({ fx_rate: 0.8, rate_source: 'manual', base_currency_amount: 48 })
  })

  it('vendor is trimmed and empty vendor saves null', () => {
    expect(buildExpensePayload(base({ vendorName: '  Ichiran ' }), 60, null, NO_FX).vendor_name).toBe('Ichiran')
  })

  it('itemised header row', () => {
    const d = base({ description: '', vendorName: 'Pizzeria', receiptPath: 'u1/r.jpg' })
    expect(buildItemizedExpensePayload(d, 58.2, NO_FX)).toEqual({
      description: 'Pizzeria', amount: 58.2, currency: 'GBP', category: 'other', vendor_name: 'Pizzeria', payment_date: '2026-11-17', paid_by: 'u1',
      participant_ids: ids, receipt_url: 'u1/r.jpg', ai_parsed: true, status: 'unallocated', fx_rate: null, fx_rate_date: null, base_currency_amount: null, rate_source: null,
    })
    expect(buildItemizedExpensePayload(d, 58.2, NO_FX, ['u1']).participant_ids).toEqual(['u1'])
  })

  it('edit: a saved record seeds the draft and re-saves identical rows', () => {
    const rec: any = {
      description: 'Dinner', vendor_name: null, amount: 60, currency: 'GBP', payment_date: '2026-11-17', category: 'food', participant_ids: ids,
      receipt_url: null, paid_by: 'u2', rate_source: null, fx_rate: null, line_items: [],
      splits: [
        { user_id: 'u1', split_type: 'percentage', percentage: 50, shares: null, amount: 30 },
        { user_id: 'u2', split_type: 'percentage', percentage: 25, shares: null, amount: 15 },
        { user_id: 'u3', split_type: 'percentage', percentage: 25, shares: null, amount: 15 },
      ],
    }
    const d = draftFromExpense(rec, ids)
    expect(d.splitMode).toBe('percentage')
    expect(d.paidBy).toBe('u2')
    expect(buildSplitRows(d, 60, NO_FX).map((r) => [r.user_id, r.amount, r.percentage])).toEqual([['u1', 30, 50], ['u2', 15, 25], ['u3', 15, 25]])
    expect(buildExpensePayload(d, 60, null, NO_FX)).toMatchObject({ category: 'food', paid_by: 'u2', participant_ids: ids })
  })

  it('edit of a manual-rate foreign expense restores the override', () => {
    const rec: any = { description: 'x', vendor_name: 'V', amount: 5, currency: 'EUR', payment_date: '2026-11-01', category: 'food', participant_ids: null, receipt_url: 'p', paid_by: 'u1', rate_source: 'manual', fx_rate: 0.8, line_items: [], splits: [] }
    const d = draftFromExpense(rec, ids)
    expect(d.fxRateOverride).toBe('0.8')
    expect(d.participantIds).toEqual(ids)
    expect(d.splitMode).toBe('equal')
  })

  it('edit of an itemised record seeds itemised mode', () => {
    const rec: any = { description: 'x', vendor_name: null, amount: 5, currency: 'GBP', payment_date: '2026-11-01', category: 'food', participant_ids: ids, receipt_url: null, paid_by: 'u1', rate_source: null, fx_rate: null, line_items: [{}], splits: [] }
    expect(draftFromExpense(rec, ids).splitMode).toBe('itemized')
  })
})

describe('participant_ids: seed from the default, write only when changed', () => {
  const defaults = ['u1', 'u2']
  const itemised = { participant_ids: null, line_items: [{}], splits: [] }

  it('a NULL list on an itemised receipt seeds the default people, not everyone', () => {
    expect(seedParticipantIds(itemised as never, defaults)).toEqual(['u1', 'u2'])
    expect(draftFromExpense({ ...itemised, description: 'x', vendor_name: null, amount: 5, currency: 'GBP', payment_date: '2026-11-01', category: 'food', receipt_url: null, paid_by: 'u1', rate_source: null, fx_rate: null } as never, defaults).participantIds).toEqual(defaults)
  })
  it('a stored list wins; an old plain split without a list is seeded from who it was split between', () => {
    expect(seedParticipantIds({ ...itemised, participant_ids: ['u3'] } as never, defaults)).toEqual(['u3'])
    expect(seedParticipantIds({ participant_ids: null, line_items: [], splits: [{ user_id: 'u3' }, { user_id: 'u1' }] } as never, defaults)).toEqual(['u3', 'u1'])
  })
  it('detects a changed selection regardless of order', () => {
    expect(participantSelectionChanged(['u2', 'u1'], defaults)).toBe(false)
    expect(participantSelectionChanged(['u1'], defaults)).toBe(true)
    expect(participantSelectionChanged(['u1', 'u3'], defaults)).toBe(true)
  })
  it('the plain edit payload leaves participant_ids out unless asked', () => {
    const d = base({})
    expect('participant_ids' in buildExpensePayload(d, 60, null, NO_FX, { includeParticipantIds: false })).toBe(false)
    expect(buildExpensePayload(d, 60, null, NO_FX, { includeParticipantIds: true }).participant_ids).toEqual(ids)
    expect(buildExpensePayload(d, 60, null, NO_FX).participant_ids).toEqual(ids)
  })
  it('the itemised header can carry NULL through unchanged', () => {
    expect(buildItemizedExpensePayload(base({}), 58.2, NO_FX, null).participant_ids).toBeNull()
  })
})

describe('header-only edit of an itemised expense', () => {
  it('sends no amount, currency or FX figures', () => {
    const d = base({ description: ' Dinner ', amount: '999', currency: 'EUR', fxRateOverride: '0.5', vendorName: 'V' })
    const payload = buildItemizedHeaderEditPayload(d, 'u1/r.jpg')
    expect(payload).toEqual({ description: 'Dinner', category: 'other', vendor_name: 'V', payment_date: '2026-11-17', paid_by: 'u1', receipt_url: 'u1/r.jpg' })
    for (const key of ['amount', 'currency', 'fx_rate', 'fx_rate_date', 'base_currency_amount', 'rate_source', 'participant_ids']) expect(key in payload).toBe(false)
  })
  it('includes the list only when it changed', () => {
    expect(buildItemizedHeaderEditPayload(base({ participantIds: ['u1'] }), null, { includeParticipantIds: true })).toMatchObject({ participant_ids: ['u1'] })
  })
})

describe('itemised header receipt', () => {
  it('uses the receipt that was just uploaded', () => {
    expect(buildItemizedExpensePayload(base({ receiptPath: null }), 10, NO_FX, ids, 'u1/new.jpg').receipt_url).toBe('u1/new.jpg')
  })
})

describe('a scan with no vendor', () => {
  it('titles the form "Receipt"', () => {
    const parsed = { vendor_name: null, total: 12, currency: 'GBP', receipt_date: null, expense_category: 'other', line_items: [] } as unknown as ParsedReceiptData
    expect(draftFromParsedReceipt(base({ description: '' }), parsed, 'u1/r.jpg')).toMatchObject({ description: 'Receipt', vendorName: '', amount: '12' })
  })
})
