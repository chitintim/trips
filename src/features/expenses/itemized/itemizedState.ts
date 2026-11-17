/**
 * Shared state for the itemized line-item editor + adjustments review
 * panel (plan §10 #3). Seeded either from a parsed ReceiptParseResult (via
 * fromReceiptParseResult) or empty for manual itemized entry.
 *
 * The money maths here is exact integer minor units. Percent tax/service and
 * flat tip/discount go through adjustmentDistribution.ts unchanged; flat tax,
 * flat service and rounding (which that module has no field for) are added by
 * the thin wrappers below (itemizedAdjustmentsConfig / computeDraftLines).
 */
import type { LineItem, ReceiptParseResult } from '../../../shared/contracts/receiptParseResult'
import {
  computeReconciliationBar,
  distributeAdjustmentsAcrossLines,
  type AdjustmentsConfig,
  type PercentAdjustmentConfig,
  type ReconciliationBarResult,
} from '../lib/adjustmentDistribution'
import { toMinorUnits, fromMinorUnits, largestRemainderDistribute, sumMinorUnits } from '../../../lib/money'
import { formatMoneyMinor } from '../lib/formatMoney'

export interface ItemizedLineItemDraft {
  lineNumber: number
  nameOriginal: string
  nameEnglish: string
  quantity: string
  unitPrice: string
  lineTotal: string
  /** Which field was printed on the receipt (informs which one to treat as authoritative if they disagree) -- mirrors ReceiptParseResult.line_items[].printed_field. */
  printedField: LineItem['printed_field']
  /** Id of the saved expense_line_items row this line continues (edit mode only); lets a re-save keep that row's claims. */
  existingLineItemId?: string
}

export interface ItemizedDraft {
  vendorName: string
  currency: string
  lineItems: ItemizedLineItemDraft[]
  adjustments: AdjustmentsConfig
  printedTotal: string
  /** Tax printed as an amount without a usable rate, added on top (minor units). Optional so older drafts keep loading. */
  flatTaxMinor?: number
  /** Service printed as an amount (or added by the "Add as service" fix), added on top (minor units). */
  flatServiceMinor?: number
  /** Printed rounding adjustment, signed (positive adds to the total), minor units. */
  roundingMinor?: number
  /** Savings printed as negative lines on the scan, already folded into the discount (minor units). Only used to tell the user. */
  foldedSavingsMinor?: number
}

/** One line as saved: the money shape the wizard hands to the mutation, plus which saved row (if any) it continues. */
export interface ItemizedSaveLine {
  name_original: string
  name_english: string | null
  quantity: number
  unit_price: number
  subtotal: number
  tax_amount: number
  service_amount: number
  line_discount_amount: number | null
  total_amount: number
  keepFromLineItemId: string | null
}

function emptyLineItem(lineNumber: number): ItemizedLineItemDraft {
  return { lineNumber, nameOriginal: '', nameEnglish: '', quantity: '1', unitPrice: '', lineTotal: '', printedField: 'ambiguous' }
}

export function emptyItemizedDraft(currency: string): ItemizedDraft {
  return {
    vendorName: '',
    currency,
    lineItems: [emptyLineItem(1)],
    adjustments: {
      tax: { mode: 'none', percent: 0 },
      service: { mode: 'none', percent: 0 },
      tipMinor: 0,
      discountMinor: 0,
    },
    printedTotal: '',
  }
}

// ---------------------------------------------------------------------------
// Totals (the single source of truth for the editor, the panel and save)
// ---------------------------------------------------------------------------

const major = (value: string, currency: string): number => toMinorUnits(parseFloat(value) || 0, currency)

/** Line prices in minor units. A negative price is an input error (see validateDraftLines), so it counts as 0 here and the totals never blow up while the message is showing. */
export function draftItemSubtotalsMinor(draft: ItemizedDraft): number[] {
  return draft.lineItems.map((l) => Math.max(0, major(l.lineTotal, draft.currency)))
}

// ---------------------------------------------------------------------------
// Input checks (inline messages instead of raw database errors)
// ---------------------------------------------------------------------------

export interface LineProblem {
  lineNumber: number
  field: 'name' | 'quantity' | 'unitPrice' | 'lineTotal'
  message: string
}

/** A blank quantity means 1. Anything typed must be at least 0.01 (the database stores 2 decimals and refuses 0). */
export function parseLineQuantity(raw: string): { value: number; problem: string | null } {
  if (raw.trim() === '') return { value: 1, problem: null }
  const q = parseFloat(raw)
  if (!Number.isFinite(q)) return { value: 1, problem: 'Enter a quantity, like 1 or 2.' }
  if (q < 0) return { value: 1, problem: "Quantity can't be negative." }
  if (Math.round(q * 100) <= 0) return { value: 1, problem: 'Quantity must be at least 0.01.' }
  return { value: q, problem: null }
}

/** Longest item name we let through, so a long paste gets a message instead of a database constraint error. */
export const MAX_ITEM_NAME_LENGTH = 200

/** Database column limits for the expense title (description) and vendor. */
export const MAX_DESCRIPTION_LENGTH = 500
export const MAX_VENDOR_LENGTH = 200

export const ZERO_TOTAL_MESSAGE = 'The items add up to 0 — add a price'

/** Short messages for a title or vendor that is too long for the database; empty object when both fit. */
export function headerTextProblems(description: string, vendorName: string): { description?: string; vendor?: string } {
  const out: { description?: string; vendor?: string } = {}
  if (description.trim().length > MAX_DESCRIPTION_LENGTH) out.description = `Keep the title under ${MAX_DESCRIPTION_LENGTH} characters.`
  if (vendorName.trim().length > MAX_VENDOR_LENGTH) out.vendor = `Keep the place name under ${MAX_VENDOR_LENGTH} characters.`
  return out
}

/** Why an itemised save would be refused before it reaches the database (zero total, over-long text), or null. */
export function itemizedWriteProblem(
  expense: { description?: string | null; vendor_name?: string | null; amount?: number | null },
  lines: Array<{ name_original: string; name_english: string | null }>,
): string | null {
  if (expense.amount != null && !(expense.amount > 0)) return ZERO_TOTAL_MESSAGE
  const h = headerTextProblems(expense.description ?? '', expense.vendor_name ?? '')
  if (h.description) return h.description
  if (h.vendor) return h.vendor
  if (lines.some((l) => l.name_original.length > MAX_ITEM_NAME_LENGTH || (l.name_english ?? '').length > MAX_ITEM_NAME_LENGTH)) {
    return `Keep item names under ${MAX_ITEM_NAME_LENGTH} characters.`
  }
  return null
}

export function validateDraftLines(draft: ItemizedDraft): LineProblem[] {
  const problems: LineProblem[] = []
  for (const l of draft.lineItems) {
    if (l.nameOriginal.length > MAX_ITEM_NAME_LENGTH || l.nameEnglish.length > MAX_ITEM_NAME_LENGTH) {
      problems.push({ lineNumber: l.lineNumber, field: 'name', message: `Keep the name under ${MAX_ITEM_NAME_LENGTH} characters.` })
    }
    const q = parseLineQuantity(l.quantity)
    if (q.problem) problems.push({ lineNumber: l.lineNumber, field: 'quantity', message: q.problem })
    if ((parseFloat(l.unitPrice) || 0) < 0) problems.push({ lineNumber: l.lineNumber, field: 'unitPrice', message: "Price can't be negative." })
    if ((parseFloat(l.lineTotal) || 0) < 0) {
      problems.push({ lineNumber: l.lineNumber, field: 'lineTotal', message: "Line total can't be negative. Put a discount on the Tax & service tab." })
    }
  }
  return problems
}

/**
 * The draft's adjustments as the plain AdjustmentsConfig that
 * adjustmentDistribution.ts understands: flat tax, flat service and positive
 * rounding fold into the tip amount, negative rounding into the discount.
 * The sum is identical (every term is a plain +/- amount), so the totals are
 * exact; only the label differs, which is why save attributes the flat tax
 * and service back to their own line fields (see computeDraftLines).
 */
export function itemizedAdjustmentsConfig(draft: ItemizedDraft): AdjustmentsConfig {
  const rounding = draft.roundingMinor ?? 0
  return {
    ...draft.adjustments,
    tipMinor: draft.adjustments.tipMinor + (draft.flatTaxMinor ?? 0) + (draft.flatServiceMinor ?? 0) + Math.max(rounding, 0),
    discountMinor: draft.adjustments.discountMinor + Math.max(-rounding, 0),
  }
}

export function draftPrintedTotalMinor(draft: ItemizedDraft): number {
  return major(draft.printedTotal, draft.currency)
}

/** Live reconciliation: items plus every adjustment against the printed total. */
export function computeDraftReconciliation(draft: ItemizedDraft): ReconciliationBarResult {
  return computeReconciliationBar(draftItemSubtotalsMinor(draft), itemizedAdjustmentsConfig(draft), draftPrintedTotalMinor(draft))
}

export interface DraftLineAmounts {
  subtotalMinor: number
  taxMinor: number
  serviceMinor: number
  discountMinor: number
  /** Everything else that lands on the line (tip, rounding) -- included in totalMinor only. */
  otherMinor: number
  totalMinor: number
}

/** Per-line amounts; flat tax and service are shared out like their percent counterparts, and the line totals add up exactly to the draft total. */
export function computeDraftLines(draft: ItemizedDraft): DraftLineAmounts[] {
  const subs = draftItemSubtotalsMinor(draft)
  const base = distributeAdjustmentsAcrossLines(subs, draft.adjustments)
  const n = subs.length
  const flatTax = n > 0 ? largestRemainderDistribute(draft.flatTaxMinor ?? 0, subs) : []
  const flatService = n > 0 ? largestRemainderDistribute(draft.flatServiceMinor ?? 0, subs) : []
  const rounding = n > 0 ? largestRemainderDistribute(draft.roundingMinor ?? 0, subs) : []
  return subs.map((subtotalMinor, i) => {
    const taxMinor = base[i].taxShareMinor + flatTax[i]
    const serviceMinor = base[i].serviceShareMinor + flatService[i]
    const discountMinor = base[i].discountShareMinor
    const otherMinor = base[i].tipShareMinor + rounding[i]
    return { subtotalMinor, taxMinor, serviceMinor, discountMinor, otherMinor, totalMinor: subtotalMinor + taxMinor + serviceMinor + otherMinor - discountMinor }
  })
}

export function draftTotalMinor(draft: ItemizedDraft): number {
  return sumMinorUnits(computeDraftLines(draft).map((l) => l.totalMinor))
}

/** The lines as saved. `keepFromLineItemId` is the id the editor carried (the caller may overwrite it with the claim diff's decision). */
export function buildSaveLines(draft: ItemizedDraft): { lines: ItemizedSaveLine[]; totalMinor: number } {
  const amounts = computeDraftLines(draft)
  const c = draft.currency
  const lines = draft.lineItems.map((l, i): ItemizedSaveLine => ({
    name_original: l.nameOriginal || `Item ${i + 1}`,
    name_english: l.nameEnglish || null,
    quantity: parseLineQuantity(l.quantity).value,
    unit_price: Math.max(0, parseFloat(l.unitPrice) || 0),
    subtotal: fromMinorUnits(amounts[i].subtotalMinor, c),
    tax_amount: fromMinorUnits(amounts[i].taxMinor, c),
    service_amount: fromMinorUnits(amounts[i].serviceMinor, c),
    line_discount_amount: amounts[i].discountMinor > 0 ? fromMinorUnits(amounts[i].discountMinor, c) : null,
    total_amount: fromMinorUnits(amounts[i].totalMinor, c),
    keepFromLineItemId: l.existingLineItemId ?? null,
  }))
  return { lines, totalMinor: sumMinorUnits(amounts.map((a) => a.totalMinor)) }
}

// ---------------------------------------------------------------------------
// Mismatch notice
// ---------------------------------------------------------------------------

export interface TotalsMismatch {
  kind: 'match' | 'short' | 'over'
  /** Size of the gap, always positive (0 on a match), minor units. */
  deltaMinor: number
  computedTotalMinor: number
  printedTotalMinor: number
  /** Formatted computed total, e.g. "£58.20" (empty on a match). */
  itemsTotalText: string
  printedTotalText: string
  deltaText: string
  /** "Items add up to £58.20, receipt says £60.00" (empty on a match). */
  message: string
}

/**
 * Compares what the items plus adjustments come to with the printed total.
 * `short` = items are below the printed total, `over` = above. With no
 * printed total there is nothing to compare, so it is a match.
 */
export function describeTotalsMismatch(draft: ItemizedDraft): TotalsMismatch {
  const printedTotalMinor = draftPrintedTotalMinor(draft)
  const { computedTotalMinor, isExact } = computeDraftReconciliation(draft)
  if (printedTotalMinor <= 0 || isExact) {
    return { kind: 'match', deltaMinor: 0, computedTotalMinor, printedTotalMinor, itemsTotalText: '', printedTotalText: '', deltaText: '', message: '' }
  }
  const diff = printedTotalMinor - computedTotalMinor
  const itemsTotalText = formatMoneyMinor(computedTotalMinor, draft.currency)
  const printedTotalText = formatMoneyMinor(printedTotalMinor, draft.currency)
  return {
    kind: diff > 0 ? 'short' : 'over',
    deltaMinor: Math.abs(diff),
    computedTotalMinor,
    printedTotalMinor,
    itemsTotalText,
    printedTotalText,
    deltaText: formatMoneyMinor(Math.abs(diff), draft.currency),
    message: `Items add up to ${itemsTotalText}, receipt says ${printedTotalText}`,
  }
}

/** One-tap fix when items are short: the gap becomes a flat service charge so the total matches the receipt. */
export function addGapAsService(draft: ItemizedDraft): ItemizedDraft {
  const m = describeTotalsMismatch(draft)
  if (m.kind !== 'short') return draft
  return { ...draft, flatServiceMinor: (draft.flatServiceMinor ?? 0) + m.deltaMinor }
}

/** One-tap fix when items are over: the gap becomes a flat discount so the total matches the receipt. */
export function addGapAsDiscount(draft: ItemizedDraft): ItemizedDraft {
  const m = describeTotalsMismatch(draft)
  if (m.kind !== 'over') return draft
  return { ...draft, adjustments: { ...draft.adjustments, discountMinor: draft.adjustments.discountMinor + m.deltaMinor } }
}

// ---------------------------------------------------------------------------
// Seeding from a parsed receipt
// ---------------------------------------------------------------------------

const roundPercent = (p: number) => Math.round(p * 10000) / 10000
const roundHalfUp = (n: number) => Math.round(n)

interface TaxOption {
  tax: PercentAdjustmentConfig
  flat: number
}
interface ServiceOption {
  service: PercentAdjustmentConfig
  flat: number
}

/**
 * Seeds an ItemizedDraft from a parsed receipt so that line totals plus
 * adjustments equal the printed total whenever the receipt reconciles.
 *
 * The receipt does not say how its numbers combine (is the tip in the total?
 * is the printed per-line discount already inside line_total? is the service
 * line in the total?), so we enumerate the plausible readings in a fixed
 * priority order and take the first whose total matches the printed total
 * (the same idea as receiptReconciliation.ts). When none does, the first
 * (default) reading is used and the editor's mismatch notice tells the user.
 *
 * Mapping decisions:
 *  - Tip: seeded as the flat tip; a reading without it is the fallback.
 *  - Discounts: receipt-level discounts (amount, or percent of the subtotal)
 *    are always subtracted. Per-line discounts are assumed to be already
 *    inside line_total (a printed line total is net); subtracting them on top
 *    is the fallback reading.
 *  - Rounding: signed flat amount, always applied.
 *  - Tax: exclusive taxes are added on top (percent mode when a single rate
 *    reproduces the printed amount, otherwise the printed amount as flat tax);
 *    inclusive taxes seed 'included' (no money). Inclusive tax re-read as
 *    added on top is the last fallback (receiptReconciliation hypothesis 5).
 *  - Service: service_charge.auto !== false is MANDATORY: first reading is
 *    added on top (percent when the rate reproduces the amount, otherwise the
 *    printed amount flat), fallback is "already included in the prices".
 *    auto === false is VOLUNTARY/suggested: the first reading is NOT applied
 *    (a suggested gratuity is usually not in the printed total, matching
 *    receiptReconciliation.ts), the fallback adds it on top. The old code had
 *    this inverted (voluntary -> 'included').
 */
export function fromReceiptParseResult(receipt: ReceiptParseResult): ItemizedDraft {
  const currency = receipt.currency
  // A saving printed as a line ("Multibuy saving -2.00") is a discount, not an
  // item: it cannot be saved as a negative price. Fold it into the
  // receipt-level discount and drop the line.
  const isSaving = (li: { line_total: number }) => toMinorUnits(li.line_total, currency) < 0
  const savingsMinor = receipt.line_items.filter(isSaving).reduce((sum, li) => sum + Math.abs(toMinorUnits(li.line_total, currency)), 0)
  const items = receipt.line_items.filter((li) => !isSaving(li))
  const lineMinor = items.map((li) => toMinorUnits(li.line_total, currency))
  const linesTotal = sumMinorUnits(lineMinor)
  const printedSubtotal = receipt.subtotal != null ? toMinorUnits(receipt.subtotal, currency) : linesTotal + savingsMinor

  const discountMinorOf = (d: { amount?: number | null; percent?: number | null }, base: number) =>
    d.amount != null ? Math.abs(toMinorUnits(d.amount, currency)) : d.percent != null ? roundHalfUp((base * d.percent) / 100) : 0
  const receiptDiscount = receipt.discounts.reduce((sum, d) => sum + discountMinorOf(d, printedSubtotal), 0) + savingsMinor
  const lineDiscount = items.reduce(
    (sum, li, i) => sum + li.discounts.reduce((s, d) => s + discountMinorOf(d, lineMinor[i]), 0),
    0
  )
  const tipMinor = receipt.tip != null ? Math.abs(toMinorUnits(receipt.tip, currency)) : 0
  const roundingMinor = receipt.rounding_adjustment != null ? toMinorUnits(receipt.rounding_adjustment, currency) : 0

  const exclusiveTaxes = receipt.tax.filter((t) => !t.inclusive)
  const inclusiveTaxes = receipt.tax.filter((t) => t.inclusive)

  const taxOptionsFor = (taxes: typeof receipt.tax, discount: number): TaxOption[] => {
    if (taxes.length === 0) {
      const inc = inclusiveTaxes.find((t) => t.rate != null)
      return [{ tax: { mode: inclusiveTaxes.length > 0 ? 'included' : 'none', percent: inc?.rate != null ? roundPercent(inc.rate * 100) : 0 }, flat: 0 }]
    }
    const options: TaxOption[] = []
    const flatAmount = sumMinorUnits(taxes.map((t) => toMinorUnits(t.amount, currency)))
    if (taxes.length === 1 && taxes[0].rate != null) {
      const pct = roundPercent(taxes[0].rate * 100)
      options.push({ tax: { mode: 'added_on_top', percent: pct }, flat: 0 })
    }
    options.push({ tax: { mode: 'none', percent: 0 }, flat: flatAmount })
    const ratesOnDiscounted = taxes.filter((t) => t.rate != null).map((t) => roundHalfUp(((linesTotal - discount) * (t.rate as number))))
    if (ratesOnDiscounted.length === taxes.length) options.push({ tax: { mode: 'none', percent: 0 }, flat: sumMinorUnits(ratesOnDiscounted) })
    return options
  }

  const sc = receipt.service_charge
  const serviceOptionsFor = (discount: number): { applied: ServiceOption[]; notApplied: ServiceOption } => {
    const none: ServiceOption = { service: { mode: 'none', percent: 0 }, flat: 0 }
    if (!sc || (sc.amount == null && sc.percent == null)) return { applied: [], notApplied: none }
    const voluntary = sc.auto === false
    const applied: ServiceOption[] = []
    if (sc.percent != null) applied.push({ service: { mode: 'added_on_top', percent: roundPercent(sc.percent) }, flat: 0 })
    const flats: number[] = []
    if (sc.amount != null) flats.push(Math.abs(toMinorUnits(sc.amount, currency)))
    if (sc.percent != null) {
      flats.push(roundHalfUp((linesTotal * sc.percent) / 100))
      flats.push(roundHalfUp(((linesTotal - discount) * sc.percent) / 100))
    }
    for (const f of [...new Set(flats)]) applied.push({ service: { mode: 'none', percent: 0 }, flat: f })
    const notApplied: ServiceOption = voluntary ? none : { service: { mode: 'included', percent: sc.percent != null ? roundPercent(sc.percent) : 0 }, flat: 0 }
    return { applied, notApplied }
  }

  const seededRows: ItemizedLineItemDraft[] = items.map((li, i) => ({
    lineNumber: i + 1,
    nameOriginal: li.name_original,
    nameEnglish: li.name_english ?? '',
    quantity: String(li.quantity),
    unitPrice: String(li.unit_price),
    lineTotal: String(li.line_total),
    printedField: li.printed_field,
  }))

  const base: ItemizedDraft = {
    vendorName: receipt.vendor_name ?? '',
    currency,
    lineItems: seededRows.length > 0 ? seededRows : [emptyLineItem(1)],
    adjustments: { tax: { mode: 'none', percent: 0 }, service: { mode: 'none', percent: 0 }, tipMinor, discountMinor: receiptDiscount },
    printedTotal: String(receipt.total),
    roundingMinor,
    foldedSavingsMinor: savingsMinor > 0 ? savingsMinor : undefined,
  }

  const candidates: ItemizedDraft[] = []
  const inclusiveReadings = inclusiveTaxes.length > 0 ? [false, true] : [false]
  const lineDiscountReadings = lineDiscount > 0 ? [false, true] : [false]
  const tipReadings = tipMinor > 0 ? [true, false] : [true]
  for (const inclusiveAsAdded of inclusiveReadings) {
    for (const subtractLineDiscount of lineDiscountReadings) {
      const discount = receiptDiscount + (subtractLineDiscount ? lineDiscount : 0)
      const taxOptions = taxOptionsFor(inclusiveAsAdded ? receipt.tax : exclusiveTaxes, discount)
      const { applied, notApplied } = serviceOptionsFor(discount)
      const voluntary = sc?.auto === false
      const serviceOptions = voluntary ? [notApplied, ...applied] : [...applied, notApplied]
      for (const withTip of tipReadings) {
        for (const taxOpt of taxOptions) {
          for (const svcOpt of serviceOptions) {
            candidates.push({
              ...base,
              adjustments: {
                tax: taxOpt.tax,
                service: svcOpt.service,
                tipMinor: withTip ? tipMinor : 0,
                discountMinor: discount,
              },
              flatTaxMinor: taxOpt.flat || undefined,
              flatServiceMinor: svcOpt.flat || undefined,
            })
          }
        }
      }
    }
  }

  const printedMinor = toMinorUnits(receipt.total, currency)
  const reconciling = candidates.find((c) => Math.abs(computeDraftReconciliation(c).computedTotalMinor - printedMinor) <= 1)
  return reconciling ?? candidates[0]
}

// ---------------------------------------------------------------------------
// Re-seeding from saved line items (edit mode)
// ---------------------------------------------------------------------------

export interface StoredLineItem {
  /** Saved row id; carried so a re-save can keep that row's claims. */
  id?: string
  line_number: number
  name_original: string
  name_english: string | null
  quantity: number
  unit_price: number
  subtotal: number
  tax_amount: number | null
  service_amount: number | null
  line_discount_amount?: number | null
  /** Saved total including tax/service/tip/discount; lets edit mode recover tip and rounding exactly. */
  total_amount?: number | null
}

/**
 * Re-seeds an ItemizedDraft from ALREADY-SAVED expense_line_items rows (edit
 * mode on an existing itemized expense). The per-line printed_field and
 * inclusive-vs-exclusive provenance isn't persisted, so tax/service are shown
 * as a percent of the subtotal when that percent reproduces the stored amount
 * to the minor unit, and as a flat amount otherwise. Any remainder between
 * the stored line totals and subtotal + tax + service - discount (a tip, or
 * rounding) is restored as tip (positive) or extra discount (negative), so
 * re-saving never shifts the total. `printedTotalMajor` (if known) switches
 * on the mismatch notice.
 */
export function fromExpenseLineItems(
  lineItems: StoredLineItem[],
  currency: string,
  opts: { printedTotalMajor?: number | null } = {}
): ItemizedDraft {
  if (lineItems.length === 0) return emptyItemizedDraft(currency)

  const sum = (pick: (l: StoredLineItem) => number | null | undefined) =>
    lineItems.reduce((acc, l) => acc + toMinorUnits(pick(l) ?? 0, currency), 0)
  const subtotalMinor = sum((l) => l.subtotal)
  const taxMinor = sum((l) => l.tax_amount)
  const serviceMinor = sum((l) => l.service_amount)
  const discountMinor = sum((l) => l.line_discount_amount)
  const percentOf = (partMinor: number) => (subtotalMinor > 0 ? Math.round((partMinor / subtotalMinor) * 10000) / 100 : 0)

  const asPercent = (partMinor: number): { config: PercentAdjustmentConfig; flat: number } => {
    if (partMinor <= 0) return { config: { mode: 'none', percent: 0 }, flat: 0 }
    const percent = percentOf(partMinor)
    if (Math.round((subtotalMinor * percent) / 100) === partMinor) return { config: { mode: 'added_on_top', percent }, flat: 0 }
    return { config: { mode: 'none', percent: 0 }, flat: partMinor }
  }
  const tax = asPercent(taxMinor)
  const service = asPercent(serviceMinor)

  const hasTotals = lineItems.every((l) => l.total_amount != null)
  const residual = hasTotals ? sum((l) => l.total_amount) - (subtotalMinor + taxMinor + serviceMinor - discountMinor) : 0

  return {
    vendorName: '',
    currency,
    lineItems: [...lineItems]
      .sort((a, b) => a.line_number - b.line_number)
      .map((li) => ({
        lineNumber: li.line_number,
        nameOriginal: li.name_original,
        nameEnglish: li.name_english ?? '',
        quantity: String(li.quantity),
        unitPrice: String(li.unit_price),
        lineTotal: String(li.subtotal),
        printedField: 'both' as const,
        existingLineItemId: li.id,
      })),
    adjustments: {
      tax: tax.config,
      service: service.config,
      tipMinor: Math.max(residual, 0),
      discountMinor: discountMinor + Math.max(-residual, 0),
    },
    printedTotal: opts.printedTotalMajor != null && opts.printedTotalMajor > 0 ? String(opts.printedTotalMajor) : '',
    flatTaxMinor: tax.flat || undefined,
    flatServiceMinor: service.flat || undefined,
  }
}

export function addLineItem(draft: ItemizedDraft): ItemizedDraft {
  const nextNumber = draft.lineItems.length > 0 ? Math.max(...draft.lineItems.map((l) => l.lineNumber)) + 1 : 1
  return { ...draft, lineItems: [...draft.lineItems, emptyLineItem(nextNumber)] }
}

export function removeLineItem(draft: ItemizedDraft, lineNumber: number): ItemizedDraft {
  const remaining = draft.lineItems.filter((l) => l.lineNumber !== lineNumber)
  // Renumber sequentially (matches v1 ItemizedSplitWizard's deleteLineItem behavior).
  const renumbered = remaining.map((l, i) => ({ ...l, lineNumber: i + 1 }))
  return { ...draft, lineItems: renumbered }
}
