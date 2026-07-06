/**
 * Shared state shape for the expense editor wizard (plan §10 #2). Each step
 * (details/payer/split/review) is its own component file; this module is
 * the single source of truth for the in-progress draft so steps never
 * derive from query data mid-edit (Form & Flow Standard point 5) and so
 * useFormDraft can persist/restore the whole draft as one JSON blob.
 */
import type { SplitMode } from '../types'

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

export const WIZARD_STEPS = [
  { key: 'details', label: 'Details' },
  { key: 'payer', label: 'Payer' },
  { key: 'split', label: 'Split' },
  { key: 'review', label: 'Review' },
] as const

export type WizardStepKey = (typeof WIZARD_STEPS)[number]['key']
