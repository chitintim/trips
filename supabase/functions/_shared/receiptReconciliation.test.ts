/**
 * Unit tests for the adjustment disambiguation engine (plan §10). Run with:
 *   deno test supabase/functions/_shared/receiptReconciliation.test.ts
 *
 * Covers the plan-mandated regression cases: UK 12.5% service, US 8.875%
 * tax, Japan inclusive dual-rate 8/10%, inclusive+service, discount cases.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { reconcileReceipt } from './receiptReconciliation.ts'
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
