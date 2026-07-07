/**
 * Shared state for the itemized line-item editor + adjustments review
 * panel (plan §10 #3). Seeded either from a parsed ReceiptParseResult (via
 * fromReceiptParseResult) or empty for manual itemized entry.
 */
import type { LineItem, ReceiptParseResult } from '../../../shared/contracts/receiptParseResult'
import type { AdjustmentsConfig, AdjustmentMode } from '../lib/adjustmentDistribution'
import { toMinorUnits } from '../../../lib/money'

export interface ItemizedLineItemDraft {
  lineNumber: number
  nameOriginal: string
  nameEnglish: string
  quantity: string
  unitPrice: string
  lineTotal: string
  /** Which field was printed on the receipt (informs which one to treat as authoritative if they disagree) -- mirrors ReceiptParseResult.line_items[].printed_field. */
  printedField: LineItem['printed_field']
}

export interface ItemizedDraft {
  vendorName: string
  currency: string
  lineItems: ItemizedLineItemDraft[]
  adjustments: AdjustmentsConfig
  printedTotal: string
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

/** Maps AI-inferred inclusive/exclusive tax + service_charge into initial segmented-choice defaults; the user can always override in the panel. */
function inferAdjustmentMode(hasCharge: boolean, isInclusive: boolean): AdjustmentMode {
  if (!hasCharge) return 'none'
  return isInclusive ? 'included' : 'added_on_top'
}

/**
 * Seeds an ItemizedDraft from a parsed receipt (plan §10: line-item editor
 * with printed_field awareness). Percent quick-selects apply on top of
 * whatever the model inferred; the reconciliation bar will tell the user
 * immediately if the seeded values don't reconcile.
 */
export function fromReceiptParseResult(receipt: ReceiptParseResult): ItemizedDraft {
  const exclusiveTax = receipt.tax.find((t) => !t.inclusive)
  const inclusiveTax = receipt.tax.find((t) => t.inclusive)
  const taxLine = exclusiveTax ?? inclusiveTax
  const taxPercent = taxLine?.rate != null ? taxLine.rate * 100 : 0

  return {
    vendorName: receipt.vendor_name ?? '',
    currency: receipt.currency,
    lineItems: receipt.line_items.map((li) => ({
      lineNumber: li.line_number,
      nameOriginal: li.name_original,
      nameEnglish: li.name_english ?? '',
      quantity: String(li.quantity),
      unitPrice: String(li.unit_price),
      lineTotal: String(li.line_total),
      printedField: li.printed_field,
    })),
    adjustments: {
      tax: { mode: inferAdjustmentMode(!!taxLine, !!inclusiveTax), percent: taxPercent },
      service: {
        mode: inferAdjustmentMode(!!receipt.service_charge, receipt.service_charge?.auto === false),
        percent: receipt.service_charge?.percent ?? 0,
      },
      tipMinor: 0, // tip is a flat amount seeded separately at the money-boundary (major->minor) by the caller
      discountMinor: 0,
    },
    printedTotal: String(receipt.total),
  }
}

export interface StoredLineItem {
  line_number: number
  name_original: string
  name_english: string | null
  quantity: number
  unit_price: number
  subtotal: number
  tax_amount: number | null
  service_amount: number | null
}

/**
 * Re-seeds an ItemizedDraft from ALREADY-SAVED expense_line_items rows (edit
 * mode on an existing itemized expense) -- the counterpart to
 * fromReceiptParseResult for expenses that didn't come from (or are past)
 * the initial parse. The per-line printed_field/inclusive-vs-exclusive
 * provenance isn't persisted at the DB row level, so tax/service mode is
 * approximated from the ratio of stored tax_amount/service_amount to
 * subtotal (close enough for the adjustments panel to show something
 * sensible rather than silently resetting to "none" on every re-edit).
 */
export function fromExpenseLineItems(lineItems: StoredLineItem[], currency: string): ItemizedDraft {
  if (lineItems.length === 0) return emptyItemizedDraft(currency)

  const subtotalMinor = lineItems.reduce((sum, l) => sum + toMinorUnits(l.subtotal, currency), 0)
  const taxMinor = lineItems.reduce((sum, l) => sum + toMinorUnits(l.tax_amount ?? 0, currency), 0)
  const serviceMinor = lineItems.reduce((sum, l) => sum + toMinorUnits(l.service_amount ?? 0, currency), 0)
  const percentOf = (partMinor: number) => (subtotalMinor > 0 ? Math.round((partMinor / subtotalMinor) * 10000) / 100 : 0)

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
      })),
    adjustments: {
      tax: { mode: taxMinor > 0 ? 'added_on_top' : 'none', percent: percentOf(taxMinor) },
      service: { mode: serviceMinor > 0 ? 'added_on_top' : 'none', percent: percentOf(serviceMinor) },
      tipMinor: 0,
      discountMinor: 0,
    },
    printedTotal: '',
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
