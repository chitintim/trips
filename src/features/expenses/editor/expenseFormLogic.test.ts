import { describe, it, expect } from 'vitest'
import { guessCategory, validateForm, primaryButtonLabel, splitSummary, dateSummary, toggleLine, itemiseChoice, categoryAfterTitle, pickEditorScreen, startsDirty } from './expenseFormLogic'
import { emptyWizardDraft, draftFromParsedReceipt, parsedLineCount } from './wizardState'
import type { ParsedReceiptData } from '../../../lib/receiptParsing'

const blank = (n = 9) =>
  emptyWizardDraft({ today: '2026-11-17', baseCurrency: 'GBP', currentUserId: 'u1', allParticipantIds: Array.from({ length: n }, (_, i) => `u${i + 1}`) })
const none = { title: true, amount: true }

describe('text length limits', () => {
  it('blocks a title over 500 and a vendor over 200', () => {
    const ok = { ...blank(), amount: '60', description: 'Dinner' }
    const longTitle = validateForm({ ...ok, description: 'x'.repeat(501) }, none)
    expect(longTitle.canSubmit).toBe(false)
    expect(longTitle.errors.title).toBeTruthy()
    const longVendor = validateForm({ ...ok, vendorName: 'v'.repeat(201) }, none)
    expect(longVendor.canSubmit).toBe(false)
    expect(longVendor.errors.vendor).toBeTruthy()
    expect(validateForm({ ...ok, description: 'x'.repeat(500), vendorName: 'v'.repeat(200) }, none).canSubmit).toBe(true)
  })
})

describe('one-screen form', () => {
  it('guesses categories from the title', () => {
    expect(guessCategory('Dinner at the izakaya')).toBe('food')
    expect(guessCategory('Taxi to airport')).toBe('transport')
    expect(guessCategory('Lift pass')).toBe('activities')
    expect(guessCategory('Stuff')).toBeNull()
  })

  it('button states the outcome', () => {
    expect(primaryButtonLabel({ ...blank(), amount: '60' }, false)).toBe('Add £60 · £6.67 each')
    expect(primaryButtonLabel({ ...blank(), amount: '' }, false)).toBe('Add expense')
    expect(primaryButtonLabel({ ...blank(3), amount: '60', splitMode: 'custom' }, false)).toBe('Add £60')
    expect(primaryButtonLabel({ ...blank(3), amount: '60' }, true)).toBe('Save changes · £60')
  })

  it('validates inline', () => {
    expect(validateForm(blank(), none).canSubmit).toBe(false)
    const ok = { ...blank(), amount: '60', description: 'Dinner' }
    expect(validateForm(ok, none).canSubmit).toBe(true)
    expect(validateForm(blank(), { title: false, amount: false }).errors).toEqual({})
    expect(validateForm(blank(), none).errors).toEqual({ title: 'Say what it was for', amount: 'Enter an amount greater than 0' })
    expect(validateForm({ ...ok, participantIds: [] }, none).errors.people).toBeTruthy()
    const bad = { ...ok, splitMode: 'percentage' as const, splitEntries: [{ userId: 'u1', value: '50' }] }
    expect(validateForm(bad, none).canSubmit).toBe(false)
    expect(validateForm(bad, none).errors.split).toContain('100%')
  })

  it('summaries and toggling', () => {
    expect(splitSummary(blank())).toBe('Split equally between 9 going')
    expect(dateSummary('2026-11-17', '2026-11-17')).toBe('Today')
    expect(toggleLine(null, 'payer')).toBe('payer')
    expect(toggleLine('payer', 'payer')).toBeNull()
    expect(toggleLine('payer', 'split')).toBe('split')
  })

  it('scan prefill carries vendor, total, currency, date, category and receipt', () => {
    const parsed = { vendor_name: ' Pizzeria ', total: 58.2, currency: 'EUR', receipt_date: '2026-11-10', expense_category: 'food', line_items: [{}, {}, {}] } as unknown as ParsedReceiptData
    const d = draftFromParsedReceipt(blank(), parsed, 'u1/r.jpg')
    expect(d).toMatchObject({ description: 'Pizzeria', vendorName: 'Pizzeria', amount: '58.2', currency: 'EUR', paymentDate: '2026-11-10', category: 'food', receiptPath: 'u1/r.jpg' })
    expect(parsedLineCount(parsed)).toBe(3)
    expect(itemiseChoice(14).label).toBe('Itemise · 14 items read')
    expect(itemiseChoice(0).show).toBe(false)
  })
})

describe('review fixes', () => {
  it('a title guess overrides the mealtime default, but never a category the person picked', () => {
    // Mealtime default 'food', not picked by the person: "Taxi home" becomes transport.
    expect(categoryAfterTitle('Taxi home', 'food', false)).toBe('transport')
    expect(categoryAfterTitle('Taxi home', 'food', true)).toBe('food')
    // No guess keeps what is there.
    expect(categoryAfterTitle('Stuff', 'food', false)).toBe('food')
  })

  it('shares mode needs at least one positive share', () => {
    const ok = { ...blank(2), amount: '60', description: 'Dinner', splitMode: 'shares' as const }
    const zero = { ...ok, splitEntries: [{ userId: 'u1', value: '0' }, { userId: 'u2', value: '0' }] }
    expect(validateForm(zero, none).canSubmit).toBe(false)
    expect(validateForm(zero, none).errors.split).toBe('Give at least one person a share.')
    expect(validateForm({ ...ok, splitEntries: [{ userId: 'u1', value: '' }, { userId: 'u2', value: '' }] }, none).canSubmit).toBe(false)
    expect(validateForm({ ...ok, splitEntries: [{ userId: 'u1', value: '2' }, { userId: 'u2', value: '0' }] }, none).canSubmit).toBe(true)
  })

  it('a frozen trip shows the frozen notice even when the itemised editor was open', () => {
    expect(pickEditorScreen(true, true)).toBe('frozen')
    expect(pickEditorScreen(true, false)).toBe('frozen')
    expect(pickEditorScreen(false, true)).toBe('itemized')
    expect(pickEditorScreen(false, false)).toBe('form')
    expect(pickEditorScreen(false, true, true)).toBe('closed')
    expect(pickEditorScreen(true, false, true)).toBe('frozen')
  })

  it('a form opened from a scan starts dirty', () => {
    expect(startsDirty({})).toBe(false)
    expect(startsDirty({ parsedData: {} })).toBe(true)
    expect(startsDirty({ parsedReceipt: {} })).toBe(true)
    expect(startsDirty({ receiptPath: 'u1/r.jpg' })).toBe(true)
  })
})
