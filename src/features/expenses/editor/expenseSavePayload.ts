/**
 * Pure builders for what the expense editor saves (expenses, expense_splits).
 * Extracted verbatim from the wizard's old handleSubmit so the one-screen form
 * and the old four-step wizard write byte-identical rows. Characterised in
 * expenseSavePayload.test.ts.
 */
import { computeSplits } from './computeSplits'
import { splitBaseCurrencyAmount, type ExpenseFxFields } from '../../../lib/fx/resolveExpenseFxFields'
import type { SplitRow, ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { ExpenseWizardDraft } from './wizardState'

export function buildSplitRows(draft: ExpenseWizardDraft, amountMajor: number, fx: ExpenseFxFields): SplitRow[] {
  const splits = computeSplits({
    mode: draft.splitMode,
    amountMajor,
    currency: draft.currency,
    participantIds: draft.participantIds,
    entries: draft.splitEntries,
  })
  return splits.map((s) => ({
    user_id: s.userId,
    amount: s.amountMajor,
    split_type:
      draft.splitMode === 'shares' ? 'shares' : draft.splitMode === 'percentage' ? 'percentage' : draft.splitMode === 'custom' ? 'custom' : 'equal',
    percentage: s.percentage,
    shares: s.shares,
    base_currency_amount: splitBaseCurrencyAmount(s.amountMajor, fx),
  }))
}

export function buildExpensePayload(
  draft: ExpenseWizardDraft,
  amountMajor: number,
  receiptUrl: string | null,
  fx: ExpenseFxFields,
  opts: { includeParticipantIds?: boolean } = {}
) {
  // An edit that did not change who was there must not write the list: the
  // stored NULL means "the default people" and is worth keeping.
  const participants = opts.includeParticipantIds === false ? {} : { participant_ids: draft.participantIds }
  return {
    description: draft.description.trim(),
    amount: amountMajor,
    currency: draft.currency,
    category: draft.category as ExpenseWithDetails['category'],
    vendor_name: draft.vendorName.trim() || null,
    payment_date: draft.paymentDate,
    paid_by: draft.paidBy,
    ...participants,
    receipt_url: receiptUrl,
    fx_rate: fx.fx_rate,
    fx_rate_date: fx.fx_rate_date,
    base_currency_amount: fx.base_currency_amount,
    rate_source: fx.rate_source,
  }
}

/**
 * Header-only edit of an itemised expense (title, category, date, payer,
 * receipt, who was there). The total belongs to the items, so no amount,
 * currency or FX figure is sent: they cannot drift from the line totals.
 */
export function buildItemizedHeaderEditPayload(draft: ExpenseWizardDraft, receiptUrl: string | null, opts: { includeParticipantIds?: boolean } = {}) {
  const participants = opts.includeParticipantIds ? { participant_ids: draft.participantIds } : {}
  return {
    description: draft.description.trim(),
    category: draft.category as ExpenseWithDetails['category'],
    vendor_name: draft.vendorName.trim() || null,
    payment_date: draft.paymentDate,
    paid_by: draft.paidBy,
    ...participants,
    receipt_url: receiptUrl,
  }
}

/** Header row saved for an itemised expense (line items + claims carry the split). */
export function buildItemizedExpensePayload(draft: ExpenseWizardDraft, totalMajor: number, fx: ExpenseFxFields, participantIds: string[] | null = draft.participantIds, receiptUrl: string | null = draft.receiptPath) {
  return {
    description: draft.description.trim() || draft.vendorName || 'Itemized receipt',
    amount: totalMajor,
    currency: draft.currency,
    category: draft.category as ExpenseWithDetails['category'],
    vendor_name: draft.vendorName.trim() || null,
    payment_date: draft.paymentDate,
    paid_by: draft.paidBy,
    participant_ids: participantIds,
    receipt_url: receiptUrl,
    ai_parsed: true,
    status: 'unallocated' as const,
    fx_rate: fx.fx_rate,
    fx_rate_date: fx.fx_rate_date,
    base_currency_amount: fx.base_currency_amount,
    rate_source: fx.rate_source,
  }
}
