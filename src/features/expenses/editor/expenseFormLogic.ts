/**
 * Pure logic for the one-screen add/edit expense form: category guess,
 * validation, summary lines and the outcome-stating primary button label.
 */
import { toMinorUnits, fromMinorUnits, largestRemainderDistribute, formatMoney as formatHeadline } from '../../../lib/money'
import { formatMoney } from '../lib/formatMoney'
import { validateSplitSum } from './computeSplits'
import type { ExpenseWizardDraft } from './wizardState'
import { headerTextProblems } from '../itemized/itemizedState'

const CATEGORY_WORDS: Array<[string, RegExp]> = [
  ['accommodation', /\b(hotel|hostel|airbnb|apartment|chalet|lodge|b&b|campsite|accommodation|rent)\b/i],
  ['transport', /\b(taxi|uber|bolt|train|bus|metro|tube|flight|ferry|fuel|petrol|diesel|parking|toll|car hire|rental car|transfer)\b/i],
  ['activities', /\b(ticket|tickets|lift pass|ski pass|museum|tour|excursion|lesson|entry|admission|spa|cinema)\b/i],
  ['equipment', /\b(ski hire|gear|equipment|boots|helmet|kit)\b/i],
  ['food', /\b(dinner|lunch|breakfast|brunch|coffee|cafe|café|bar|pub|drinks?|beer|wine|pizza|ramen|sushi|restaurant|groceries|supermarket|snacks?|bakery|tapas|burger|takeaway)\b/i],
]

/** Guesses a category from the title; mealtime default for unmatched titles is left to the caller (returns null). */
export function guessCategory(title: string): string | null {
  for (const [cat, re] of CATEGORY_WORDS) if (re.test(title)) return cat
  return null
}

/**
 * The category after the title changes. A guess from the title wins over the
 * mealtime default and an earlier guess, but never over a category the person
 * picked themselves. No guess leaves the category as it is.
 */
export function categoryAfterTitle(title: string, current: string, userPicked: boolean): string {
  if (userPicked) return current
  return guessCategory(title) ?? current
}

export interface FormErrors {
  title?: string
  vendor?: string
  amount?: string
  people?: string
  split?: string
}

export function validateForm(draft: ExpenseWizardDraft, touched: { title: boolean; amount: boolean }): { errors: FormErrors; canSubmit: boolean } {
  const amountMajor = parseFloat(draft.amount) || 0
  const errors: FormErrors = {}
  const hard: boolean[] = []
  const titleBad = draft.description.trim().length === 0
  const amountBad = amountMajor <= 0
  hard.push(titleBad, amountBad)
  const text = headerTextProblems(draft.description, draft.vendorName ?? '')
  if (text.description) {
    errors.title = text.description
    hard.push(true)
  }
  if (text.vendor) {
    errors.vendor = text.vendor
    hard.push(true)
  }
  if (titleBad && touched.title) errors.title = 'Say what it was for'
  if (amountBad && touched.amount) errors.amount = 'Enter an amount greater than 0'
  if (draft.participantIds.length === 0) {
    errors.people = 'Pick at least one person to split it with'
    hard.push(true)
  }
  if ((draft.splitMode === 'custom' || draft.splitMode === 'percentage') && amountMajor > 0) {
    const v = validateSplitSum(draft.splitMode, draft.splitEntries, draft.participantIds, amountMajor, draft.currency)
    if (!v.isValid) {
      errors.split =
        draft.splitMode === 'percentage'
          ? `Percentages add up to ${v.sumMajor}%, they need to make 100%.`
          : `Amounts add up to ${formatMoney(v.sumMajor, draft.currency)}, they need to make ${formatMoney(v.targetMajor, draft.currency)}.`
      hard.push(true)
    }
  }
  if (draft.splitMode === 'shares' && draft.participantIds.length > 0) {
    // A blank or zero share counts for nothing; with no positive share there is nothing to split by.
    const anyShare = draft.participantIds.some((id) => (parseFloat(draft.splitEntries.find((e) => e.userId === id)?.value ?? '') || 0) > 0)
    if (!anyShare) {
      errors.split = 'Give at least one person a share.'
      hard.push(true)
    }
  }
  return { errors, canSubmit: !hard.some(Boolean) && !!draft.paidBy }
}

/** "Add £60 · £6.67 each" for equal splits, "Add £60" otherwise; edits say "Save changes". */
export function primaryButtonLabel(draft: ExpenseWizardDraft, isEdit: boolean): string {
  const amountMajor = parseFloat(draft.amount) || 0
  if (isEdit) return amountMajor > 0 ? `Save changes · ${formatHeadline(amountMajor, draft.currency)}` : 'Save changes'
  if (amountMajor <= 0) return 'Add expense'
  const total = formatHeadline(amountMajor, draft.currency)
  if (draft.splitMode === 'equal' && draft.participantIds.length > 1) {
    const minor = toMinorUnits(amountMajor, draft.currency)
    const parts = largestRemainderDistribute(minor, draft.participantIds.map(() => 1))
    return `Add ${total} · ${formatHeadline(fromMinorUnits(Math.max(...parts), draft.currency), draft.currency)} each`
  }
  return `Add ${total}`
}

export function splitSummary(draft: ExpenseWizardDraft): string {
  const n = draft.participantIds.length
  const going = `${n} going`
  switch (draft.splitMode) {
    case 'equal':
      return `Split equally between ${going}`
    case 'custom':
      return `Split by custom amounts between ${going}`
    case 'percentage':
      return `Split by percent between ${going}`
    case 'shares':
      return `Split by shares between ${going}`
    default:
      return `Itemised between ${going}`
  }
}

export function dateSummary(paymentDate: string, today: string): string {
  if (paymentDate === today) return 'Today'
  const d = new Date(`${paymentDate}T00:00:00`)
  return Number.isNaN(d.getTime()) ? paymentDate : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}

/** Which of the summary lines are open: only tapped ones. At most one at a time. */
export type OpenLine = 'payer' | 'split' | 'date' | null
export function toggleLine(current: OpenLine, line: Exclude<OpenLine, null>): OpenLine {
  return current === line ? null : line
}

/** Scan prefill: the Itemise / Just split the total choice. */
export function itemiseChoice(lineCount: number): { show: boolean; label: string } {
  return { show: lineCount >= 1, label: `Itemise · ${lineCount} ${lineCount === 1 ? 'item' : 'items'} read` }
}

/** What the frozen trip shows instead of a form: never let anyone fill it and fail at save. */
export function isFrozen(trip: { settlement_snapshot?: unknown }): boolean {
  return !!trip.settlement_snapshot
}

/** Which screen the editor shows. A frozen trip wins over everything, including a stale itemised editor left open; then a closed receipt. */
export function pickEditorScreen(frozen: boolean, showItemized: boolean, claimsClosed = false): 'frozen' | 'closed' | 'itemized' | 'form' {
  if (frozen) return 'frozen'
  // A receipt whose claims are closed is final for amount, currency, payer, people and items until the payer reopens it (the database refuses
  // those writes), so the editor shows a notice instead of a form that would fail on save.
  if (claimsClosed) return 'closed'
  return showItemized ? 'itemized' : 'form'
}

/** A form opened from a scan already holds something worth keeping (and a scan that costs a daily allowance), so closing it asks first. */
export function startsDirty(scan: { parsedData?: unknown; parsedReceipt?: unknown; receiptPath?: string | null }): boolean {
  return !!(scan.parsedData || scan.parsedReceipt || scan.receiptPath)
}
