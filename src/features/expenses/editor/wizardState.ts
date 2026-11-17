/**
 * Shared state shape for the expense editor wizard (plan §10 #2). Each step
 * (details/payer/split/review) is its own component file; this module is
 * the single source of truth for the in-progress draft so steps never
 * derive from query data mid-edit (Form & Flow Standard point 5) and so
 * useFormDraft can persist/restore the whole draft as one JSON blob.
 */
import type { SplitMode } from '../types'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { ParsedReceiptData } from '../../../lib/receiptParsing'

export interface SplitEntry {
  userId: string
  /** Custom mode: raw entered amount (major units, string for input binding). Percentage mode: percent string. Shares mode: share weight (default 1, couples 2x). */
  value: string
}

export interface ExpenseWizardDraft {
  // --- details step ---
  description: string
  vendorName: string
  amount: string
  currency: string
  paymentDate: string // YYYY-MM-DD
  category: string
  /** expenses.participant_ids -- "who was there?", defaults to all participants. */
  participantIds: string[]
  receiptPath: string | null

  // --- payer step ---
  paidBy: string

  // --- split step ---
  splitMode: SplitMode
  splitEntries: SplitEntry[]
  /** Accommodation-only: whether nights-weighting was applied (informational, re-derivable). */
  nightsWeightingApplied: boolean

  // --- review step ---
  fxRateOverride: string | null // manual rate override, writes rate_source='manual'
}

export function emptyWizardDraft(defaults: {
  today: string
  baseCurrency: string
  currentUserId: string
  allParticipantIds: string[]
}): ExpenseWizardDraft {
  return {
    description: '',
    vendorName: '',
    amount: '',
    currency: defaults.baseCurrency,
    paymentDate: defaults.today,
    category: 'other',
    participantIds: [...defaults.allParticipantIds],
    receiptPath: null,
    paidBy: defaults.currentUserId,
    splitMode: 'equal',
    splitEntries: defaults.allParticipantIds.map((userId) => ({ userId, value: '' })),
    nightsWeightingApplied: false,
    fxRateOverride: null,
  }
}

/** A new expense's payer is the signed-in user; if they were not known when the draft was made, fill it in later but never over a choice. */
export function withDefaultPayer(draft: ExpenseWizardDraft, userId: string | undefined): ExpenseWizardDraft {
  return draft.paidBy || !userId ? draft : { ...draft, paidBy: userId }
}

export const WIZARD_STEPS = [
  { key: 'details', label: 'Details' },
  { key: 'payer', label: 'Payer' },
  { key: 'split', label: 'Split' },
  { key: 'review', label: 'Review' },
] as const


/**
 * Who a saved expense is for, as the editor starts out. A stored list wins. A
 * NULL list (every itemised receipt, and older expenses) means "the default
 * people", so it is seeded from the in-scope default rather than from every
 * active participant (which would include declined people), or, for an old
 * plain split, from the people it was actually split between.
 */
export function seedParticipantIds(
  expense: Pick<ExpenseWithDetails, 'participant_ids' | 'splits' | 'line_items'>,
  defaultTaggedIds: string[]
): string[] {
  if (expense.participant_ids) return expense.participant_ids
  if (expense.line_items.length === 0 && expense.splits.length > 0) return expense.splits.map((s) => s.user_id)
  return defaultTaggedIds
}

/** True when the selection differs from what the editor was seeded with (order does not matter). */
export function participantSelectionChanged(selected: string[], seeded: string[]): boolean {
  if (selected.length !== seeded.length) return true
  const set = new Set(seeded)
  return selected.some((id) => !set.has(id))
}

/** Seeds the draft from a saved expense (edit mode). Pure so the round trip is testable. `defaultTaggedIds` = defaultTaggedParticipantIds(participants, isConfirmationEnabled(trip)). */
export function draftFromExpense(expense: ExpenseWithDetails, defaultTaggedIds: string[]): ExpenseWizardDraft {
  return {
    description: expense.description,
    vendorName: expense.vendor_name ?? '',
    amount: String(expense.amount),
    currency: expense.currency,
    paymentDate: expense.payment_date,
    category: expense.category,
    participantIds: seedParticipantIds(expense, defaultTaggedIds),
    receiptPath: expense.receipt_url,
    paidBy: expense.paid_by,
    // Itemized expenses have no expense_splits rows; line_items presence is the signal.
    splitMode: expense.line_items.length > 0 ? 'itemized' : expense.splits[0]?.split_type ?? 'equal',
    splitEntries: expense.splits.map((s) => ({
      userId: s.user_id,
      value:
        s.split_type === 'percentage'
          ? String(s.percentage ?? '')
          : s.split_type === 'shares'
            ? String(s.shares ?? '1')
            : s.split_type === 'custom'
              ? String(s.amount)
              : '',
    })),
    nightsWeightingApplied: false,
    fxRateOverride: expense.rate_source === 'manual' && expense.fx_rate ? String(expense.fx_rate) : null,
  }
}

const VALID_CATEGORIES = ['accommodation', 'transport', 'food', 'activities', 'equipment', 'other']

/** Everything the scan read, laid over a blank draft. Nothing parsed is dropped here: the full parse also travels to the itemised editor. */
export function draftFromParsedReceipt(blank: ExpenseWizardDraft, parsed: ParsedReceiptData, receiptPath: string | null): ExpenseWizardDraft {
  const vendor = parsed.vendor_name?.trim() ?? ''
  return {
    ...blank,
    description: vendor || blank.description || 'Receipt',
    vendorName: vendor,
    amount: parsed.total > 0 ? String(parsed.total) : blank.amount,
    currency: parsed.currency || blank.currency,
    paymentDate: parsed.receipt_date || blank.paymentDate,
    category: VALID_CATEGORIES.includes(parsed.expense_category) ? parsed.expense_category : 'food',
    receiptPath: receiptPath ?? blank.receiptPath,
  }
}

/** Number of lines the scan read (v2 receipt preferred, legacy list as fallback). */
export function parsedLineCount(parsed: ParsedReceiptData | null | undefined): number {
  if (!parsed) return 0
  return parsed.v2?.receipt.line_items.length ?? parsed.line_items?.length ?? 0
}
