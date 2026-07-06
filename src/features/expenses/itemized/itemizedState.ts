/**
 * Shared state for the itemized line-item editor + adjustments review
 * panel (plan §10 #3). Seeded either from a parsed ReceiptParseResult (via
 * fromReceiptParseResult) or empty for manual itemized entry.
 */
import type { LineItem, ReceiptParseResult } from '../../../shared/contracts/receiptParseResult'
import type { AdjustmentsConfig, AdjustmentMode } from '../lib/adjustmentDistribution'

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
