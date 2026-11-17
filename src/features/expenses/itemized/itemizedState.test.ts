import { describe, it, expect } from 'vitest'
import type { ReceiptParseResult } from '../../../shared/contracts/receiptParseResult'
import { toMinorUnits } from '../../../lib/money'
import {
  fromExpenseLineItems,
  fromReceiptParseResult,
  emptyItemizedDraft,
  describeTotalsMismatch,
  addGapAsService,
  addGapAsDiscount,
  buildSaveLines,
  computeDraftLines,
  draftTotalMinor,
  validateDraftLines,
  headerTextProblems,
  itemizedWriteProblem,
  ZERO_TOTAL_MESSAGE,
  MAX_ITEM_NAME_LENGTH,
  parseLineQuantity,
  type StoredLineItem,
} from './itemizedState'

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

// ---------------------------------------------------------------------------
// Seeding: line totals + adjustments = printed total
// ---------------------------------------------------------------------------

type Receipt = ReceiptParseResult

function line(n: number, name: string, total: number, extra: Partial<Receipt['line_items'][number]> = {}): Receipt['line_items'][number] {
  return { line_number: n, name_original: name, quantity: 1, unit_price: total, line_total: total, printed_field: 'both', discounts: [], ...extra }
}

function receipt(over: Partial<Receipt>): Receipt {
  return {
    vendor_name: 'Test',
    receipt_date: null,
    currency: 'GBP',
    line_items: [],
    tax: [],
    discounts: [],
    confidence: [],
    subtotal: null,
    total: 0,
    ...over,
  } as Receipt
}

function expectReconciles(r: Receipt) {
  const draft = fromReceiptParseResult(r)
  expect(draftTotalMinor(draft)).toBe(toMinorUnits(r.total, r.currency))
  expect(describeTotalsMismatch(draft).kind).toBe('match')
  return draft
}

describe('fromReceiptParseResult seeding', () => {
  it('plain lines, no adjustments', () => {
    expectReconciles(receipt({ line_items: [line(1, 'A', 10), line(2, 'B', 20.5)], total: 30.5 }))
  })

  it('mandatory service percent added on top', () => {
    const d = expectReconciles(
      receipt({ line_items: [line(1, 'A', 40), line(2, 'B', 20)], service_charge: { percent: 12.5, amount: 7.5, auto: true }, total: 67.5 })
    )
    expect(d.adjustments.service).toEqual({ mode: 'added_on_top', percent: 12.5 })
  })

  it('mandatory service with an amount only is a flat amount added on top', () => {
    const d = expectReconciles(receipt({ line_items: [line(1, 'A', 50)], service_charge: { amount: 6.35, auto: true }, total: 56.35 }))
    expect(d.flatServiceMinor).toBe(635)
  })

  it('voluntary service (auto === false) is NOT added when the printed total excludes it', () => {
    const d = expectReconciles(receipt({ line_items: [line(1, 'A', 50)], service_charge: { percent: 12.5, amount: 6.25, auto: false }, total: 50 }))
    expect(d.adjustments.service.mode).toBe('none')
    expect(d.flatServiceMinor).toBeUndefined()
  })

  it('voluntary service whose amount is in the printed total is added on top', () => {
    const d = expectReconciles(receipt({ line_items: [line(1, 'A', 50)], service_charge: { percent: 12.5, amount: 6.25, auto: false }, total: 56.25 }))
    expect(d.adjustments.service).toEqual({ mode: 'added_on_top', percent: 12.5 })
  })

  it('mandatory service already included in the prices is "included"', () => {
    const d = expectReconciles(receipt({ line_items: [line(1, 'A', 50)], service_charge: { percent: 10, amount: 5, auto: true }, total: 50 }))
    expect(d.adjustments.service.mode).toBe('included')
  })

  it('tip is seeded as a flat amount', () => {
    const d = expectReconciles(receipt({ line_items: [line(1, 'A', 30), line(2, 'B', 25)], tip: 5, total: 60 }))
    expect(d.adjustments.tipMinor).toBe(500)
  })

  it('receipt-level discount (amount) is subtracted', () => {
    const d = expectReconciles(receipt({ line_items: [line(1, 'A', 30), line(2, 'B', 25)], discounts: [{ amount: 5 }], total: 50 }))
    expect(d.adjustments.discountMinor).toBe(500)
  })

  it('receipt-level discount given only as a percent', () => {
    expectReconciles(receipt({ line_items: [line(1, 'A', 80)], subtotal: 80, discounts: [{ percent: 10 }], total: 72 }))
  })

  it('line discounts already inside line_total are not subtracted twice', () => {
    const d = expectReconciles(receipt({ line_items: [line(1, 'A', 18, { discounts: [{ amount: 2 }] }), line(2, 'B', 10)], total: 28 }))
    expect(d.adjustments.discountMinor).toBe(0)
  })

  it('line discounts printed separately from a gross line_total are subtracted', () => {
    const d = expectReconciles(receipt({ line_items: [line(1, 'A', 20, { discounts: [{ amount: 2 }] }), line(2, 'B', 10)], total: 28 }))
    expect(d.adjustments.discountMinor).toBe(200)
  })

  it('exclusive tax with a matching rate seeds a percent', () => {
    const d = expectReconciles(receipt({ line_items: [line(1, 'A', 100)], tax: [{ rate: 0.08, amount: 8, inclusive: false }], total: 108 }))
    expect(d.adjustments.tax).toEqual({ mode: 'added_on_top', percent: 8 })
  })

  it('exclusive tax with an amount but no rate is a flat tax', () => {
    const d = expectReconciles(receipt({ line_items: [line(1, 'A', 33.3)], tax: [{ amount: 2.77, inclusive: false }], total: 36.07 }))
    expect(d.flatTaxMinor).toBe(277)
    expect(d.adjustments.tax.mode).toBe('none')
  })

  it('inclusive tax adds nothing and is shown as included', () => {
    const d = expectReconciles(receipt({ line_items: [line(1, 'A', 60)], tax: [{ rate: 0.2, amount: 10, inclusive: true }], total: 60 }))
    expect(d.adjustments.tax).toEqual({ mode: 'included', percent: 20 })
  })

  it('inclusive tax plus a mandatory service charge', () => {
    expectReconciles(
      receipt({ line_items: [line(1, 'A', 60)], tax: [{ rate: 0.2, amount: 10, inclusive: true }], service_charge: { percent: 10, amount: 6, auto: true }, total: 66 })
    )
  })

  it('rounding adjustment (negative and positive)', () => {
    const neg = expectReconciles(receipt({ line_items: [line(1, 'A', 10.02)], rounding_adjustment: -0.02, total: 10 }))
    expect(neg.roundingMinor).toBe(-2)
    const pos = expectReconciles(receipt({ line_items: [line(1, 'A', 9.98)], rounding_adjustment: 0.02, total: 10 }))
    expect(pos.roundingMinor).toBe(2)
  })

  it('discount then service percent then tax then tip all together', () => {
    // 100 - 10 = 90; service 10% of 90 = 9 (flat); tax 5.85 flat; tip 3 => 107.85
    expectReconciles(
      receipt({
        line_items: [line(1, 'A', 60), line(2, 'B', 40)],
        discounts: [{ amount: 10 }],
        service_charge: { percent: 10, auto: true },
        tax: [{ amount: 5.85, inclusive: false }],
        tip: 3,
        total: 107.85,
      })
    )
  })

  it('JPY (zero-decimal)', () => {
    const d = expectReconciles(
      receipt({
        currency: 'JPY',
        line_items: [line(1, 'Ramen', 1000), line(2, 'Beer', 700)],
        tax: [{ rate: 0.1, amount: 170, inclusive: false }],
        total: 1870,
      })
    )
    expect(d.adjustments.tax).toEqual({ mode: 'added_on_top', percent: 10 })
    expectReconciles(receipt({ currency: 'JPY', line_items: [line(1, 'Set', 1100)], tax: [{ rate: 0.1, amount: 100, inclusive: true }], rounding_adjustment: -1, total: 1099 }))
  })

  it('keeps the printed total and flags a mismatch when the receipt does not reconcile', () => {
    const d = fromReceiptParseResult(receipt({ line_items: [line(1, 'A', 58.2)], total: 60 }))
    expect(d.printedTotal).toBe('60')
    const m = describeTotalsMismatch(d)
    expect(m.kind).toBe('short')
    expect(m.deltaMinor).toBe(180)
    expect(m.message).toBe('Items add up to £58.20, receipt says £60.00')
  })
})

describe('totals and line amounts', () => {
  it('per-line amounts add up exactly to the total, with flat tax/service/rounding', () => {
    const d = fromReceiptParseResult(
      receipt({
        line_items: [line(1, 'A', 3.33), line(2, 'B', 3.33), line(3, 'C', 3.34)],
        tax: [{ amount: 1.01, inclusive: false }],
        service_charge: { amount: 1.0, auto: true },
        rounding_adjustment: -0.01,
        total: 12,
      })
    )
    const lines = computeDraftLines(d)
    expect(lines.reduce((s, l) => s + l.totalMinor, 0)).toBe(draftTotalMinor(d))
    expect(lines.reduce((s, l) => s + l.taxMinor, 0)).toBe(101)
    expect(lines.reduce((s, l) => s + l.serviceMinor, 0)).toBe(100)
    expect(draftTotalMinor(d)).toBe(1200)
  })

  it('buildSaveLines carries existing ids and totals', () => {
    const d = fromExpenseLineItems(
      [{ id: 'row1', line_number: 1, name_original: 'A', name_english: null, quantity: 1, unit_price: 10, subtotal: 10, tax_amount: 0, service_amount: 0, total_amount: 11 }],
      'GBP'
    )
    expect(d.adjustments.tipMinor).toBe(100)
    const { lines, totalMinor } = buildSaveLines(d)
    expect(lines[0].keepFromLineItemId).toBe('row1')
    expect(lines[0].total_amount).toBe(11)
    expect(totalMinor).toBe(1100)
  })
})

describe('describeTotalsMismatch and fixes', () => {
  const base = fromReceiptParseResult(receipt({ line_items: [line(1, 'A', 58.2)], total: 58.2 }))

  it('is a match when totals agree and when there is no printed total', () => {
    expect(describeTotalsMismatch(base).kind).toBe('match')
    expect(describeTotalsMismatch({ ...base, printedTotal: '' }).kind).toBe('match')
  })

  it('short: add the gap as service makes the total match', () => {
    const d = { ...base, printedTotal: '60' }
    const m = describeTotalsMismatch(d)
    expect(m).toMatchObject({ kind: 'short', deltaMinor: 180, deltaText: '£1.80' })
    const fixed = addGapAsService(d)
    expect(describeTotalsMismatch(fixed).kind).toBe('match')
    expect(draftTotalMinor(fixed)).toBe(6000)
  })

  it('over: add the gap as discount makes the total match', () => {
    const d = { ...base, printedTotal: '55' }
    const m = describeTotalsMismatch(d)
    expect(m).toMatchObject({ kind: 'over', deltaMinor: 320 })
    expect(describeTotalsMismatch(addGapAsDiscount(d)).kind).toBe('match')
    expect(addGapAsService(d)).toBe(d)
  })

  it('works in JPY', () => {
    const d = fromReceiptParseResult(receipt({ currency: 'JPY', line_items: [line(1, 'A', 1000)], total: 1000 }))
    const short = { ...d, printedTotal: '1200' }
    expect(describeTotalsMismatch(short).message).toBe('Items add up to ¥1,000, receipt says ¥1,200')
    expect(describeTotalsMismatch(addGapAsService(short)).kind).toBe('match')
  })
})

describe('negative parsed lines and input checks', () => {
  it('folds a printed saving into the receipt discount and drops the line', () => {
    const d = expectReconciles(receipt({ line_items: [line(1, 'Milk', 10), line(2, 'Cheese', 5), line(3, 'Multibuy saving', -2)], total: 13 }))
    expect(d.lineItems.map((l) => l.nameOriginal)).toEqual(['Milk', 'Cheese'])
    expect(d.lineItems.map((l) => l.lineNumber)).toEqual([1, 2])
    expect(d.adjustments.discountMinor).toBe(200)
    expect(d.foldedSavingsMinor).toBe(200)
    // Saves cleanly: no negative subtotal, no throw.
    const { lines, totalMinor } = buildSaveLines(d)
    expect(totalMinor).toBe(1300)
    expect(lines.every((l) => l.subtotal >= 0 && l.total_amount >= 0)).toBe(true)
  })

  it('a receipt of only savings still gives one blank row to type into', () => {
    const d = fromReceiptParseResult(receipt({ line_items: [line(1, 'Saving', -2)], total: 0 }))
    expect(d.lineItems).toHaveLength(1)
    expect(d.lineItems[0].nameOriginal).toBe('')
  })

  it('does not throw while a typed line total is negative', () => {
    const d = { ...emptyItemizedDraft('GBP'), lineItems: [{ ...emptyItemizedDraft('GBP').lineItems[0], lineTotal: '-3' }] }
    expect(() => buildSaveLines(d)).not.toThrow()
    expect(validateDraftLines(d)).toEqual([{ lineNumber: 1, field: 'lineTotal', message: expect.stringContaining("can't be negative") }])
  })

  it('refuses quantities that round to 0.00 at 2 dp, zero and negative', () => {
    expect(parseLineQuantity('0.004').problem).toBeTruthy()
    expect(parseLineQuantity('0').problem).toBeTruthy()
    expect(parseLineQuantity('-1').problem).toMatch(/negative/)
    expect(parseLineQuantity('0.01').problem).toBeNull()
    expect(parseLineQuantity('').value).toBe(1)
    expect(parseLineQuantity('2.5').value).toBe(2.5)
    const base = emptyItemizedDraft('GBP')
    const bad = { ...base, lineItems: [{ ...base.lineItems[0], quantity: '-1', lineTotal: '5' }] }
    expect(validateDraftLines(bad).map((p) => p.field)).toEqual(['quantity'])
    expect(validateDraftLines({ ...base, lineItems: [{ ...base.lineItems[0], lineTotal: '5' }] })).toEqual([])
  })

  it('flags an over-long item name', () => {
    const base = emptyItemizedDraft('GBP')
    const long = { ...base, lineItems: [{ ...base.lineItems[0], nameOriginal: 'x'.repeat(201), lineTotal: '5' }] }
    expect(validateDraftLines(long).map((p) => p.field)).toEqual(['name'])
  })
})

describe('database limits', () => {
  it('flags an English name that is too long as well as the original', () => {
    const d = emptyItemizedDraft('GBP')
    d.lineItems[0].nameEnglish = 'x'.repeat(MAX_ITEM_NAME_LENGTH + 1)
    expect(validateDraftLines(d).map((p) => p.field)).toContain('name')
    d.lineItems[0].nameEnglish = 'x'.repeat(MAX_ITEM_NAME_LENGTH)
    expect(validateDraftLines(d).filter((p) => p.field === 'name')).toEqual([])
  })

  it('limits title to 500 and vendor to 200', () => {
    expect(headerTextProblems('a'.repeat(500), 'b'.repeat(200))).toEqual({})
    expect(headerTextProblems('a'.repeat(501), 'b'.repeat(201))).toEqual({
      description: 'Keep the title under 500 characters.',
      vendor: 'Keep the place name under 200 characters.',
    })
  })

  it('refuses a zero total, long text and long item names before saving', () => {
    const lines = [{ name_original: 'A', name_english: null }]
    expect(itemizedWriteProblem({ description: 'D', vendor_name: null, amount: 0 }, lines)).toBe(ZERO_TOTAL_MESSAGE)
    expect(itemizedWriteProblem({ description: 'D'.repeat(501), amount: 5 }, lines)).toMatch(/title/)
    expect(itemizedWriteProblem({ description: 'D', vendor_name: 'v'.repeat(201), amount: 5 }, lines)).toMatch(/place name/)
    expect(itemizedWriteProblem({ description: 'D', amount: 5 }, [{ name_original: 'A', name_english: 'e'.repeat(201) }])).toMatch(/item names/)
    expect(itemizedWriteProblem({ description: 'D', vendor_name: 'V', amount: 5 }, lines)).toBeNull()
  })
})
