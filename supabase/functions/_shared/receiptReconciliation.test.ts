/**
 * Unit tests for the adjustment disambiguation engine (plan §10). Run with:
 *   deno test supabase/functions/_shared/receiptReconciliation.test.ts
 *
 * Covers the plan-mandated regression cases: UK 12.5% service, US 8.875%
 * tax, Japan inclusive dual-rate 8/10%, inclusive+service, discount cases.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { reconcileReceipt, buildRepairPrompt } from './receiptReconciliation.ts'
import type { ReceiptParseResult } from './contracts/receiptParseResult.ts'

function baseReceipt(overrides: Partial<ReceiptParseResult>): ReceiptParseResult {
  return {
    vendor_name: 'Test Vendor',
    vendor_name_english: null,
    vendor_address: null,
    receipt_date: '2026-06-01',
    currency: 'GBP',
    line_items: [],
    tax: [],
    service_charge: null,
    tip: null,
    discounts: [],
    rounding_adjustment: null,
    subtotal: null,
    total: 0,
    confidence: [],
    notes: null,
    ...overrides,
  }
}

Deno.test('UK restaurant: 12.5% service charge added on top', () => {
  // Two mains, no tax breakdown (VAT already in UK menu prices), 12.5% service on top.
  const receipt = baseReceipt({
    currency: 'GBP',
    line_items: [
      { line_number: 1, name_original: 'Steak', name_english: null, quantity: 1, unit_price: 24.0, line_total: 24.0, printed_field: 'both', discounts: [] },
      { line_number: 2, name_original: 'Wine', name_english: null, quantity: 1, unit_price: 16.0, line_total: 16.0, printed_field: 'both', discounts: [] },
    ],
    subtotal: 40.0,
    total: 45.0, // 40 * 1.125 = 45.00 exactly
  })

  const result = reconcileReceipt(receipt)
  assert(result.reconciled, `expected reconciliation, got: ${result.explanation}`)
  assertEquals(result.hypothesis, 'service_12_5pct')
})

Deno.test('US receipt: 8.875% sales tax added on top (NYC rate)', () => {
  const receipt = baseReceipt({
    currency: 'USD',
    line_items: [
      { line_number: 1, name_original: 'Burger', name_english: null, quantity: 1, unit_price: 15.0, line_total: 15.0, printed_field: 'both', discounts: [] },
      { line_number: 2, name_original: 'Fries', name_english: null, quantity: 1, unit_price: 5.0, line_total: 5.0, printed_field: 'both', discounts: [] },
    ],
    subtotal: 20.0,
    tax: [{ label: 'Sales Tax', rate: 0.08875, amount: 1.78, inclusive: false }],
    total: 21.78, // 20 + 1.775 rounded to 1.78 = 21.78
  })

  const result = reconcileReceipt(receipt)
  assert(result.reconciled, `expected reconciliation, got: ${result.explanation}`)
  // Printed tax amount is 1.78 (already rounded by the store) -- the
  // printed_fields_as_is hypothesis (Σlines + printed non-inclusive tax)
  // should reconcile directly since it uses the *printed* tax amount, not
  // a recomputed rate*subtotal.
  assertEquals(result.hypothesis, 'printed_fields_as_is')
})

Deno.test('Japan: inclusive dual-rate 8%/10% receipt (all-inclusive, tax informational only)', () => {
  // Japanese receipts print consumption tax as an informational breakdown;
  // item prices already include it. 8% rate for food, 10% for other goods --
  // both informational, total = sum of line totals (already tax-inclusive).
  const receipt = baseReceipt({
    currency: 'JPY',
    line_items: [
      { line_number: 1, name_original: 'おにぎり', name_english: 'Rice ball', quantity: 2, unit_price: 150, line_total: 300, printed_field: 'line_total', discounts: [] },
      { line_number: 2, name_original: '雑誌', name_english: 'Magazine', quantity: 1, unit_price: 500, line_total: 500, printed_field: 'line_total', discounts: [] },
    ],
    subtotal: 800,
    tax: [
      { label: '8%対象', rate: 0.08, amount: 22, inclusive: true },
      { label: '10%対象', rate: 0.10, amount: 45, inclusive: true },
    ],
    total: 800, // inclusive tax -> total equals sum of line totals
  })

  const result = reconcileReceipt(receipt)
  assert(result.reconciled, `expected reconciliation, got: ${result.explanation}`)
  // With no service charge and only *inclusive* tax lines, "printed fields
  // as-is" and "all-inclusive" reduce to the identical computation (both
  // sum line totals with no add-on) -- printed_fields_as_is is tried first
  // and wins the tie. Either label is arithmetically correct here; the
  // model's provenance labels would be what actually distinguishes them in
  // a real ambiguous case.
  assertEquals(result.hypothesis, 'printed_fields_as_is')
})

Deno.test('European inclusive VAT + service added on top', () => {
  // e.g. French restaurant: TVA already in menu prices, but a separate
  // "service compris" style charge is still added as a distinct line here
  // (variant where service is NOT already folded in) at 10%.
  const receipt = baseReceipt({
    currency: 'EUR',
    line_items: [
      { line_number: 1, name_original: 'Plat principal', name_english: 'Main course', quantity: 2, unit_price: 22.0, line_total: 44.0, printed_field: 'both', discounts: [] },
    ],
    subtotal: 44.0,
    tax: [{ label: 'TVA', rate: 0.10, amount: 4.0, inclusive: true }],
    total: 48.4, // 44 * 1.10 = 48.40 (10% service on top of tax-inclusive prices)
  })

  const result = reconcileReceipt(receipt)
  assert(result.reconciled, `expected reconciliation, got: ${result.explanation}`)
  assertEquals(result.hypothesis, 'tax_inclusive_service_added')
})

Deno.test('Discount case: percentage discount off subtotal reconciles exactly', () => {
  const receipt = baseReceipt({
    currency: 'GBP',
    line_items: [
      { line_number: 1, name_original: 'Haircut', name_english: null, quantity: 1, unit_price: 30.0, line_total: 30.0, printed_field: 'both', discounts: [] },
    ],
    subtotal: 30.0,
    discounts: [{ label: 'Loyalty discount', amount: null, percent: 10 }],
    total: 27.0, // 30 - 10% = 27
  })

  const result = reconcileReceipt(receipt)
  assert(result.reconciled, `expected reconciliation, got: ${result.explanation}`)
  // No tax/service fields at all -> printed_fields_as_is and all_inclusive
  // are the identical computation (see the Japan test above); the former is
  // tried first.
  assertEquals(result.hypothesis, 'printed_fields_as_is')
})

Deno.test('Discount case: fixed-amount discount plus standard service rate', () => {
  const receipt = baseReceipt({
    currency: 'GBP',
    line_items: [
      { line_number: 1, name_original: 'Pizza', name_english: null, quantity: 2, unit_price: 12.0, line_total: 24.0, printed_field: 'both', discounts: [] },
      { line_number: 2, name_original: 'Salad', name_english: null, quantity: 1, unit_price: 6.0, line_total: 6.0, printed_field: 'both', discounts: [] },
    ],
    subtotal: 30.0,
    discounts: [{ label: '£5 off voucher', amount: 5.0, percent: null }],
    // (30 - 5) * 1.10 = 27.50
    total: 27.5,
  })

  const result = reconcileReceipt(receipt)
  assert(result.reconciled, `expected reconciliation, got: ${result.explanation}`)
  assertEquals(result.hypothesis, 'service_10pct')
})

Deno.test('Nothing reconciles: falls back to printed-total-trusted with review flags', () => {
  const receipt = baseReceipt({
    currency: 'GBP',
    line_items: [
      { line_number: 1, name_original: 'Mystery item', name_english: null, quantity: 1, unit_price: 10.0, line_total: 10.0, printed_field: 'ambiguous', discounts: [] },
    ],
    subtotal: 10.0,
    total: 55.55, // wildly inconsistent, no hypothesis should reconcile
  })

  const result = reconcileReceipt(receipt)
  assertEquals(result.reconciled, false)
  assertEquals(result.hypothesis, 'printed_total_trusted')
  assertEquals(result.computedTotalMinor, result.printedTotalMinor)
  assert(result.lineReviewFlags.includes(1))
  assertEquals(result.hasAmbiguousLines, true)
})

Deno.test('Rounding adjustment (cash rounding) is honored in printed_fields_as_is', () => {
  const receipt = baseReceipt({
    currency: 'GBP',
    line_items: [
      { line_number: 1, name_original: 'Coffee', name_english: null, quantity: 1, unit_price: 2.98, line_total: 2.98, printed_field: 'both', discounts: [] },
    ],
    subtotal: 2.98,
    rounding_adjustment: 0.02,
    total: 3.0,
  })

  const result = reconcileReceipt(receipt)
  assert(result.reconciled, `expected reconciliation, got: ${result.explanation}`)
  assertEquals(result.hypothesis, 'printed_fields_as_is')
})

// ---------------------------------------------------------------------------
// WSH adversarial regression corpus (plan §16: "Receipt-parser regression
// set" + §10 adversarial dimensions: VAT-inclusive EU, US tax-exclusive
// multi-rate, Japan 8/10% dual with 単価/金額 ambiguity, service auto vs tip,
// line+receipt discounts stacked, zero-decimal JPY rounding, cash rounding,
// unparseable fallback). Each fixture below is a distinct real-world shape
// not covered by the original 8 cases above.
// ---------------------------------------------------------------------------

Deno.test('Japan conbini: zero-decimal dual-rate 8%/10% EXCLUSIVE tax (printed as separate add-on, not inclusive)', () => {
  // Some Japanese receipts (notably certain convenience-store formats) print
  // consumption tax as an exclusive add-on rather than folding it into line
  // prices. Two tax groups (food 8%, non-food 10%) each carry their own
  // *printed* tax amount -- hypothesis 1 must sum the printed per-line tax
  // amounts directly (not recompute rate*fullBase, which would double-count
  // across groups with different taxable bases).
  const receipt = baseReceipt({
    currency: 'JPY',
    line_items: [
      { line_number: 1, name_original: 'おにぎり', name_english: 'Rice ball', quantity: 2, unit_price: 150, line_total: 300, printed_field: 'both', discounts: [] },
      { line_number: 2, name_original: '雑誌', name_english: 'Magazine', quantity: 1, unit_price: 500, line_total: 500, printed_field: 'both', discounts: [] },
    ],
    subtotal: 800,
    tax: [
      { label: '8%対象', rate: 0.08, amount: 24, inclusive: false }, // 300 * 0.08 = 24
      { label: '10%対象', rate: 0.10, amount: 50, inclusive: false }, // 500 * 0.10 = 50
    ],
    total: 874, // 800 + 24 + 50
  })

  const result = reconcileReceipt(receipt)
  assert(result.reconciled, `expected reconciliation, got: ${result.explanation}`)
  assertEquals(result.hypothesis, 'printed_fields_as_is')
})

Deno.test('Japan: 単価/金額 ambiguous line still reconciles via printed line_total (unit_price*qty disagrees)', () => {
  // Handwritten/OCR-noisy receipt where the model could not tell whether the
  // printed number was unit_price or line_total for one line (marked
  // 'ambiguous'), and a naive qty*unit_price recompute would NOT match the
  // printed line_total (e.g. weighed/bulk item priced per 100g). The engine
  // must trust the model's `line_total` field (the authoritative field per
  // plan §10) rather than recomputing from quantity*unit_price, so the
  // receipt still reconciles overall -- while the line itself is still
  // surfaced for user review if nothing reconciles further up the chain.
  const receipt = baseReceipt({
    currency: 'JPY',
    line_items: [
      // qty=3, unit_price=100 would naively suggest line_total=300, but this
      // is a per-100g item actually weighing 233g -- printed_field is
      // 'ambiguous' because the model can't structurally tell which of the
      // two printed numbers is the "real" one, but line_total (233) is what
      // was actually printed as the charged amount.
      { line_number: 1, name_original: '惣菜(量り売り)', name_english: 'Deli (by weight)', quantity: 3, unit_price: 100, line_total: 233, printed_field: 'ambiguous', discounts: [] },
      { line_number: 2, name_original: 'お茶', name_english: 'Tea', quantity: 1, unit_price: 150, line_total: 150, printed_field: 'both', discounts: [] },
    ],
    subtotal: 383,
    total: 383, // all-inclusive, JPY dual tax informational only (omitted here for brevity)
  })

  const result = reconcileReceipt(receipt)
  assert(result.reconciled, `expected reconciliation, got: ${result.explanation}`)
  // Even though line 1 is ambiguous, the printed line_total (233) is what's
  // summed -- reconciliation succeeds and the ambiguity is only surfaced via
  // hasAmbiguousLines, not by refusing to reconcile.
  assertEquals(result.hasAmbiguousLines, true)
})

Deno.test('Voluntary/suggested service charge (auto:false) NOT applied to the printed total is correctly excluded', () => {
  // US-style slip: the receipt prints a suggested-gratuity line (often shown
  // as 18/20/22% options) but the customer declined it -- the actual printed
  // total charged is just subtotal + sales tax, with no service amount
  // folded in. The engine must not force-add a voluntary charge that isn't
  // actually reflected in the total (regression for a real bug found during
  // WSH replay: printed_fields_as_is previously added service_charge
  // unconditionally regardless of the `auto` flag).
  const receipt = baseReceipt({
    currency: 'USD',
    line_items: [
      { line_number: 1, name_original: 'Burger', name_english: null, quantity: 1, unit_price: 15.0, line_total: 15.0, printed_field: 'both', discounts: [] },
      { line_number: 2, name_original: 'Fries', name_english: null, quantity: 1, unit_price: 5.0, line_total: 5.0, printed_field: 'both', discounts: [] },
    ],
    subtotal: 20.0,
    tax: [{ label: 'Sales Tax', rate: 0.08875, amount: 1.78, inclusive: false }],
    service_charge: { amount: null, percent: 20, auto: false }, // suggested gratuity, NOT applied
    total: 21.78, // subtotal + tax only -- gratuity was declined
  })

  const result = reconcileReceipt(receipt)
  assert(result.reconciled, `expected reconciliation, got: ${result.explanation}`)
  assertEquals(result.hypothesis, 'printed_fields_as_is')
  // computedTotal should NOT include the 20% suggested service.
  assertEquals(result.computedTotalMinor, 2178)
})

Deno.test('Voluntary service charge (auto:false) that WAS applied to the total still reconciles (fallback variant)', () => {
  // Same voluntary/suggested-gratuity shape, but this time the diner opted
  // in and the printed total genuinely includes it -- the engine must still
  // find this reconciliation as a fallback when the "not applied" variant
  // doesn't match the printed total.
  const receipt = baseReceipt({
    currency: 'USD',
    line_items: [
      { line_number: 1, name_original: 'Meal', name_english: null, quantity: 1, unit_price: 50.0, line_total: 50.0, printed_field: 'both', discounts: [] },
    ],
    subtotal: 50.0,
    service_charge: { amount: null, percent: 20, auto: false },
    total: 60.0, // 50 * 1.20 -- suggested gratuity was opted into
  })

  const result = reconcileReceipt(receipt)
  assert(result.reconciled, `expected reconciliation, got: ${result.explanation}`)
  assertEquals(result.hypothesis, 'printed_fields_as_is')
  assertEquals(result.computedTotalMinor, 6000)
})

Deno.test('Mandatory (auto:true) service charge is always applied, never treated as optional', () => {
  // Sanity check that the auto:false special-casing above does NOT change
  // behavior for the (much more common) mandatory case -- a mandatory
  // service charge must always be assumed present in the total, with no
  // "not applied" variant tried.
  const receipt = baseReceipt({
    currency: 'GBP',
    line_items: [
      { line_number: 1, name_original: 'Steak', name_english: null, quantity: 1, unit_price: 24.0, line_total: 24.0, printed_field: 'both', discounts: [] },
      { line_number: 2, name_original: 'Wine', name_english: null, quantity: 1, unit_price: 16.0, line_total: 16.0, printed_field: 'both', discounts: [] },
    ],
    subtotal: 40.0,
    service_charge: { amount: null, percent: 12.5, auto: true },
    total: 45.0,
  })

  const result = reconcileReceipt(receipt)
  assert(result.reconciled, `expected reconciliation, got: ${result.explanation}`)
  assertEquals(result.hypothesis, 'printed_fields_as_is')
})

Deno.test('Tip field present is ignored by reconciliation (tip is added after the printed total, not part of it)', () => {
  // `tip` is a separate, voluntary, post-total amount the customer writes in
  // on a card slip -- it must never be folded into the receipt's own
  // reconciliation math (only service_charge and tax are receipt-printed
  // adjustments). A populated tip field should have zero effect on whether
  // -- or how -- the receipt reconciles.
  const receipt = baseReceipt({
    currency: 'USD',
    line_items: [
      { line_number: 1, name_original: 'Brunch', name_english: null, quantity: 1, unit_price: 30.0, line_total: 30.0, printed_field: 'both', discounts: [] },
    ],
    subtotal: 30.0,
    tip: 6.0, // hand-written tip on the slip -- NOT part of the receipt total
    total: 30.0, // printed receipt total excludes the tip entirely
  })

  const result = reconcileReceipt(receipt)
  assert(result.reconciled, `expected reconciliation, got: ${result.explanation}`)
  // No tax/service fields at all -> printed_fields_as_is and all_inclusive
  // are the identical computation (tried in that order); the tip field has
  // zero bearing on either.
  assertEquals(result.hypothesis, 'printed_fields_as_is')
  assertEquals(result.computedTotalMinor, 3000)
})

Deno.test('Line-level discounts already baked into line_total do not get double-subtracted', () => {
  // Per the ReceiptParseResult contract, line_items[].discounts[] is
  // provenance metadata explaining *why* a line_total is what it is -- the
  // printed line_total is already net-of-discount. Only receipt-level
  // `discounts[]` should be subtracted by the engine; a populated line-level
  // discounts array must not cause any additional subtraction.
  const receipt = baseReceipt({
    currency: 'GBP',
    line_items: [
      {
        line_number: 1, name_original: 'Shirt', name_english: null, quantity: 1,
        unit_price: 20.0, line_total: 16.0, printed_field: 'line_total',
        discounts: [{ amount: 4.0, percent: null, reason: 'Clearance markdown' }],
      },
      { line_number: 2, name_original: 'Socks', name_english: null, quantity: 1, unit_price: 5.0, line_total: 5.0, printed_field: 'both', discounts: [] },
    ],
    subtotal: 21.0, // 16 + 5, already net of the line-level markdown
    total: 21.0,
  })

  const result = reconcileReceipt(receipt)
  assert(result.reconciled, `expected reconciliation, got: ${result.explanation}`)
  assertEquals(result.computedTotalMinor, 2100)
})

Deno.test('Stacked discounts: line-level markdown (baked into line_total) + receipt-level percentage discount both apply correctly', () => {
  const receipt = baseReceipt({
    currency: 'GBP',
    line_items: [
      {
        line_number: 1, name_original: 'Jacket', name_english: null, quantity: 1,
        unit_price: 100.0, line_total: 80.0, printed_field: 'line_total',
        discounts: [{ amount: 20.0, percent: null, reason: 'Item markdown' }],
      },
    ],
    subtotal: 80.0,
    discounts: [{ label: 'Loyalty card 10% off', amount: null, percent: 10 }],
    total: 72.0, // 80 * 0.90 = 72 -- receipt-level % discount applies on top of the already-marked-down line
  })

  const result = reconcileReceipt(receipt)
  assert(result.reconciled, `expected reconciliation, got: ${result.explanation}`)
  assertEquals(result.computedTotalMinor, 7200)
})

Deno.test('EU VAT-inclusive with a receipt-level fixed discount voucher (discount applied before reconciling to total)', () => {
  const receipt = baseReceipt({
    currency: 'EUR',
    line_items: [
      { line_number: 1, name_original: 'Menu du jour', name_english: 'Set menu', quantity: 2, unit_price: 18.0, line_total: 36.0, printed_field: 'both', discounts: [] },
    ],
    subtotal: 36.0,
    tax: [{ label: 'TVA', rate: 0.20, amount: 6.0, inclusive: true }],
    discounts: [{ label: 'Coupon', amount: 6.0, percent: null }],
    total: 30.0, // 36 - 6 voucher = 30, VAT already inclusive, no service
  })

  const result = reconcileReceipt(receipt)
  assert(result.reconciled, `expected reconciliation, got: ${result.explanation}`)
})

Deno.test('Zero-decimal JPY: percentage tax rounding (333 yen line at 10% exclusive tax rounds to nearest yen)', () => {
  const receipt = baseReceipt({
    currency: 'JPY',
    line_items: [
      { line_number: 1, name_original: 'Item', name_english: null, quantity: 1, unit_price: 333, line_total: 333, printed_field: 'both', discounts: [] },
    ],
    subtotal: 333,
    tax: [{ label: '10%対象', rate: 0.10, amount: 33, inclusive: false }], // 33.3 rounds to 33
    total: 366,
  })

  const result = reconcileReceipt(receipt)
  assert(result.reconciled, `expected reconciliation, got: ${result.explanation}`)
  assertEquals(result.computedTotalMinor, 366)
  // JPY is zero-decimal: 366 minor units === 366 yen (no /100 scaling).
  assertEquals(result.printedTotalMinor, 366)
})

Deno.test('Zero-decimal JPY: cash rounding down to nearest 10 yen (rounding_adjustment negative)', () => {
  // Some JPY cash transactions round the final total to the nearest 10 yen;
  // rounding_adjustment carries the (possibly negative) delta explicitly
  // rather than the engine inferring it.
  const receipt = baseReceipt({
    currency: 'JPY',
    line_items: [
      { line_number: 1, name_original: 'Item A', name_english: null, quantity: 1, unit_price: 297, line_total: 297, printed_field: 'both', discounts: [] },
      { line_number: 2, name_original: 'Item B', name_english: null, quantity: 1, unit_price: 148, line_total: 148, printed_field: 'both', discounts: [] },
    ],
    subtotal: 445,
    rounding_adjustment: -5, // 445 rounds down to 440
    total: 440,
  })

  const result = reconcileReceipt(receipt)
  assert(result.reconciled, `expected reconciliation, got: ${result.explanation}`)
  assertEquals(result.hypothesis, 'printed_fields_as_is')
  assertEquals(result.computedTotalMinor, 440)
})

Deno.test('Cash rounding to nearest 0.05 (Swiss/Australian style, negative adjustment)', () => {
  const receipt = baseReceipt({
    currency: 'CHF',
    line_items: [
      { line_number: 1, name_original: 'Item', name_english: null, quantity: 1, unit_price: 23.97, line_total: 23.97, printed_field: 'both', discounts: [] },
    ],
    subtotal: 23.97,
    rounding_adjustment: -0.02, // 23.97 rounds down to 23.95
    total: 23.95,
  })

  const result = reconcileReceipt(receipt)
  assert(result.reconciled, `expected reconciliation, got: ${result.explanation}`)
  assertEquals(result.computedTotalMinor, 2395)
})

Deno.test('Unparseable/garbage fallback: empty line items with only a printed total still returns a safe non-reconciled result', () => {
  // Worst case: OCR/model extraction failed to find any line items at all
  // (e.g. a badly crumpled or handwritten receipt) but a total was still
  // read. The engine must never throw, must trust the printed total, and
  // must flag for review rather than fabricate a reconciliation.
  const receipt = baseReceipt({
    currency: 'GBP',
    line_items: [],
    subtotal: null,
    total: 42.5,
  })

  const result = reconcileReceipt(receipt)
  assertEquals(result.reconciled, false)
  assertEquals(result.hypothesis, 'printed_total_trusted')
  assertEquals(result.computedTotalMinor, result.printedTotalMinor)
  // No line items to flag individually, but the fallback must not crash and
  // must return a defined (possibly empty) review-flags array.
  assert(Array.isArray(result.lineReviewFlags))
})

Deno.test('Negative line amount (refund/credit line) nets correctly against positive lines', () => {
  // Plan §16: "allow negative amounts as refunds". A receipt with a partial
  // refund/credit line (e.g. a returned item credited back) should reconcile
  // by simply summing signed line totals.
  const receipt = baseReceipt({
    currency: 'GBP',
    line_items: [
      { line_number: 1, name_original: 'Item', name_english: null, quantity: 1, unit_price: 25.0, line_total: 25.0, printed_field: 'both', discounts: [] },
      { line_number: 2, name_original: 'Refund: returned item', name_english: null, quantity: 1, unit_price: -10.0, line_total: -10.0, printed_field: 'both', discounts: [] },
    ],
    subtotal: 15.0,
    total: 15.0,
  })

  const result = reconcileReceipt(receipt)
  assert(result.reconciled, `expected reconciliation, got: ${result.explanation}`)
  assertEquals(result.computedTotalMinor, 1500)
})

Deno.test('Multiple non-inclusive tax lines at different rates (US multi-jurisdiction: state + local) sum correctly without double-counting', () => {
  // US receipts sometimes break sales tax into state + local components as
  // separate printed lines, both exclusive. printed_fields_as_is must sum
  // BOTH printed tax amounts (not just the first), reflecting the true
  // combined add-on.
  const receipt = baseReceipt({
    currency: 'USD',
    line_items: [
      { line_number: 1, name_original: 'Widget', name_english: null, quantity: 1, unit_price: 100.0, line_total: 100.0, printed_field: 'both', discounts: [] },
    ],
    subtotal: 100.0,
    tax: [
      { label: 'State Tax', rate: 0.0625, amount: 6.25, inclusive: false },
      { label: 'Local Tax', rate: 0.02, amount: 2.0, inclusive: false },
    ],
    total: 108.25,
  })

  const result = reconcileReceipt(receipt)
  assert(result.reconciled, `expected reconciliation, got: ${result.explanation}`)
  assertEquals(result.hypothesis, 'printed_fields_as_is')
  assertEquals(result.computedTotalMinor, 10825)
})

Deno.test('Ambiguous printed_field lines are individually flagged for review even when the receipt as a whole reconciles', () => {
  // hasAmbiguousLines must surface true even on a successful reconciliation
  // so the UI can still prompt a quick confirm on the ambiguous line,
  // without blocking the overall "looks right?" quick-capture flow (plan
  // §10 Entry UX).
  const receipt = baseReceipt({
    currency: 'JPY',
    line_items: [
      { line_number: 1, name_original: '弁当', name_english: 'Bento', quantity: 1, unit_price: 500, line_total: 500, printed_field: 'ambiguous', discounts: [] },
    ],
    subtotal: 500,
    total: 500,
  })

  const result = reconcileReceipt(receipt)
  assert(result.reconciled, `expected reconciliation, got: ${result.explanation}`)
  assertEquals(result.hasAmbiguousLines, true)
})

Deno.test('buildRepairPrompt: formats JPY (zero-decimal) amounts without decimal places', () => {
  const receipt = baseReceipt({
    currency: 'JPY',
    line_items: [
      { line_number: 1, name_original: 'Item', name_english: null, quantity: 1, unit_price: 500, line_total: 500, printed_field: 'both', discounts: [] },
    ],
    subtotal: 500,
    total: 9999, // wildly inconsistent -> falls back to printed_total_trusted
  })

  const result = reconcileReceipt(receipt)
  assertEquals(result.reconciled, false)
  const prompt = buildRepairPrompt(receipt, result)
  assert(prompt.includes('500 JPY'), `expected whole-yen formatting, got: ${prompt}`)
  assert(prompt.includes('9999 JPY'), `expected whole-yen formatting, got: ${prompt}`)
  assert(!prompt.includes('500.00'), `should not print decimal places for JPY, got: ${prompt}`)
})

Deno.test('Tolerance boundary: exactly 1 minor unit off reconciles; 2 minor units off does not', () => {
  const receiptOffByOne = baseReceipt({
    currency: 'GBP',
    line_items: [
      { line_number: 1, name_original: 'Item', name_english: null, quantity: 1, unit_price: 10.0, line_total: 10.0, printed_field: 'both', discounts: [] },
    ],
    subtotal: 10.0,
    total: 10.01, // 1p off (e.g. a rounding quirk not captured elsewhere)
  })
  const resultOffByOne = reconcileReceipt(receiptOffByOne)
  assert(resultOffByOne.reconciled, `expected 1p tolerance to reconcile, got: ${resultOffByOne.explanation}`)
  assertEquals(resultOffByOne.hypothesis, 'printed_fields_as_is')

  const receiptOffByTwo = baseReceipt({
    currency: 'GBP',
    line_items: [
      { line_number: 1, name_original: 'Item', name_english: null, quantity: 1, unit_price: 10.0, line_total: 10.0, printed_field: 'both', discounts: [] },
    ],
    subtotal: 10.0,
    total: 10.02, // 2p off -- must NOT reconcile at default 1-minor-unit tolerance
  })
  const resultOffByTwo = reconcileReceipt(receiptOffByTwo)
  assertEquals(resultOffByTwo.reconciled, false)
})
