import { describe, it, expect } from 'vitest'
import { fromExpenseLineItems, emptyItemizedDraft, type StoredLineItem } from './itemizedState'

describe('fromExpenseLineItems', () => {
  it('re-seeds line items from stored expense_line_items rows, sorted by line_number', () => {
    const stored: StoredLineItem[] = [
      { line_number: 2, name_original: 'Ramen', name_english: null, quantity: 1, unit_price: 12, subtotal: 12, tax_amount: 0, service_amount: 0 },
      { line_number: 1, name_original: 'Gyoza', name_english: 'Dumplings', quantity: 2, unit_price: 4, subtotal: 8, tax_amount: 0, service_amount: 0 },
    ]
    const draft = fromExpenseLineItems(stored, 'GBP')
    expect(draft.lineItems.map((l) => l.lineNumber)).toEqual([1, 2])
    expect(draft.lineItems[0]).toMatchObject({ nameOriginal: 'Gyoza', nameEnglish: 'Dumplings', quantity: '2', unitPrice: '4', lineTotal: '8', printedField: 'both' })
  })

  it('falls back to an empty draft when there are no stored line items', () => {
    const draft = fromExpenseLineItems([], 'GBP')
    expect(draft).toEqual(emptyItemizedDraft('GBP'))
  })

  it('approximates tax/service adjustment mode+percent from stored per-line amounts', () => {
    const stored: StoredLineItem[] = [
      { line_number: 1, name_original: 'Item', name_english: null, quantity: 1, unit_price: 100, subtotal: 100, tax_amount: 10, service_amount: 5 },
    ]
    const draft = fromExpenseLineItems(stored, 'GBP')
    expect(draft.adjustments.tax).toEqual({ mode: 'added_on_top', percent: 10 })
    expect(draft.adjustments.service).toEqual({ mode: 'added_on_top', percent: 5 })
  })

  it('defaults tax/service to "none" when no tax/service was stored', () => {
    const stored: StoredLineItem[] = [
      { line_number: 1, name_original: 'Item', name_english: null, quantity: 1, unit_price: 100, subtotal: 100, tax_amount: null, service_amount: null },
    ]
    const draft = fromExpenseLineItems(stored, 'GBP')
    expect(draft.adjustments.tax.mode).toBe('none')
    expect(draft.adjustments.service.mode).toBe('none')
  })

  it('handles a zero-decimal currency (JPY) without throwing', () => {
    const stored: StoredLineItem[] = [
      { line_number: 1, name_original: 'Item', name_english: null, quantity: 1, unit_price: 1000, subtotal: 1000, tax_amount: 100, service_amount: 0 },
    ]
    const draft = fromExpenseLineItems(stored, 'JPY')
    expect(draft.lineItems[0].lineTotal).toBe('1000')
    expect(draft.adjustments.tax.mode).toBe('added_on_top')
  })
})
