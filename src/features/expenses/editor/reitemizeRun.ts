/**
 * Re-itemising an expense (or turning a plain one into an itemised receipt).
 *
 * The database function `reitemize_expense(p_expense_id, p_header, p_lines,
 * p_preview)` does the work: one transaction under the right permissions, it
 * keeps claims on items that did not change and tells us whose claims it
 * cleared. With p_preview = true it writes nothing and answers the same
 * question, which drives the Save-time warning.
 *
 * The functions take `rpc` so they can be unit-tested without a network.
 */
import type { RpcError } from '../../../lib/queries/useExpenses'
import { itemizedWriteProblem, type ItemizedSaveLine } from '../itemized/itemizedState'

// ---------------------------------------------------------------------------
// Plain messages for the function's error hints
// ---------------------------------------------------------------------------

const MESSAGES: Record<string, string> = {
  forbidden: 'Only the person who paid, or a trip organiser, can change the items on this receipt.',
  frozen: "Balances are frozen while people settle up, so this receipt can't be changed. An organizer can unfreeze them in Settle up.",
  currency_unsupported: "Itemising isn't available in this currency yet.",
  bad_line: "One of the items has an amount we can't save. Check the quantities and prices.",
  claims_closed: "This receipt's claims are closed, so its items can't be changed. Reopen it first.",
  closed: "This receipt's claims are closed, so its items can't be changed. Reopen it first.",
  bad_header: 'The currency changed, so enter the exchange rate for it before saving.',
  bad_input: "One of the amounts is too large or isn't a valid number. Check the prices.",
  not_found: "This receipt can't be found any more.",
  reload: 'This copy of the app is out of date. Reload the page, then try again.',
}
const GENERIC = "We couldn't save the changes to this receipt. Try again."

export class ReitemizeError extends Error {
  hint: string | null
  constructor(message: string, hint: string | null = null) {
    super(message)
    this.name = 'ReitemizeError'
    this.hint = hint
  }
}

export function reitemizeErrorMessage(error: { code?: string; hint?: string; message?: string } | null | undefined): string {
  const hint = error?.hint
  if (hint && MESSAGES[hint]) return MESSAGES[hint]
  if (error?.code === '42501') return MESSAGES.forbidden
  return GENERIC
}

function toReitemizeError(error: RpcError): ReitemizeError {
  return new ReitemizeError(reitemizeErrorMessage(error), error.hint ?? null)
}

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

/** Keys of the itemised header payload the function accepts; anything else is not sent. */
const HEADER_KEYS = [
  'description', 'vendor_name', 'category', 'payment_date', 'paid_by', 'participant_ids',
  'receipt_url', 'currency', 'fx_rate', 'fx_rate_date', 'rate_source',
] as const

export function toRpcHeader(expense: Record<string, unknown>): Record<string, unknown> {
  const header: Record<string, unknown> = {}
  for (const key of HEADER_KEYS) if (key in expense && expense[key] !== undefined) header[key] = expense[key]
  return header
}

export function toRpcLines(lines: ItemizedSaveLine[]): Array<Record<string, unknown>> {
  return lines.map((l) => ({
    id: l.keepFromLineItemId,
    name_original: l.name_original,
    name_english: l.name_english,
    quantity: l.quantity,
    unit_price: l.unit_price,
    subtotal: l.subtotal,
    tax_amount: l.tax_amount,
    service_amount: l.service_amount,
    line_discount_amount: l.line_discount_amount,
    total_amount: l.total_amount,
  }))
}

export interface ReitemizeOutcome {
  keptClaims: number
  clearedClaims: number
  clearedUserIds: string[]
  /** People who said "That's everything": the database deleted that answer because the items or total changed, so they must check again. */
  reconfirmUserIds: string[]
  leftoversCleared: boolean
  /** The expense had no allocation link: the CLIENT creates it (the code is client-generated). */
  needsLink: boolean
}

export function parseReitemizeResult(data: unknown): ReitemizeOutcome {
  const d = (data ?? {}) as Record<string, unknown>
  const ids = Array.isArray(d.cleared_user_ids) ? (d.cleared_user_ids as unknown[]).filter((x): x is string => typeof x === 'string') : []
  const reconfirm = Array.isArray(d.reconfirm_user_ids) ? (d.reconfirm_user_ids as unknown[]).filter((x): x is string => typeof x === 'string') : []
  return {
    reconfirmUserIds: reconfirm,
    needsLink: d.needs_link === true,
    keptClaims: typeof d.kept_claims === 'number' ? d.kept_claims : 0,
    clearedClaims: typeof d.cleared_claims === 'number' ? d.cleared_claims : ids.length,
    clearedUserIds: ids,
    leftoversCleared: d.leftovers_cleared === true,
  }
}

export type RpcFn = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: RpcError | null }>

export interface ReitemizeArgs {
  expenseId: string
  /** The whole itemised header payload (amount = sum of the lines, status 'unallocated', ...). */
  expense: Record<string, unknown>
  lineItems: ItemizedSaveLine[]
}

/** Refuses, with a plain message, a write the database would reject (zero total, over-long text). */
function assertWritable(args: ReitemizeArgs): void {
  const problem = itemizedWriteProblem(args.expense as { description?: string; vendor_name?: string | null; amount?: number }, args.lineItems)
  if (problem) throw new ReitemizeError(problem)
}

// ---------------------------------------------------------------------------
// Preview (Save time)
// ---------------------------------------------------------------------------

/** Asks what a save would clear, without writing. */
export async function previewReitemize(rpc: RpcFn, args: ReitemizeArgs): Promise<ReitemizeOutcome> {
  assertWritable(args)
  const { data, error } = await rpc('reitemize_expense', {
    p_expense_id: args.expenseId,
    p_header: toRpcHeader(args.expense),
    p_lines: toRpcLines(args.lineItems),
    p_preview: true,
  })
  if (error) throw toReitemizeError(error)
  return parseReitemizeResult(data)
}

// ---------------------------------------------------------------------------
// The save
// ---------------------------------------------------------------------------

export interface ReitemizeSaveResult {
  clearedClaims: number
  clearedUserIds: string[]
  reconfirmUserIds: string[]
  /** true = no allocation link exists yet; the caller creates one. */
  needsLink: boolean
  leftoversCleared: boolean
}

export async function runReitemize(rpc: RpcFn, args: ReitemizeArgs): Promise<ReitemizeSaveResult> {
  assertWritable(args)
  const { data, error } = await rpc('reitemize_expense', {
    p_expense_id: args.expenseId,
    p_header: toRpcHeader(args.expense),
    p_lines: toRpcLines(args.lineItems),
    p_preview: false,
  })
  if (error) throw toReitemizeError(error)
  const o = parseReitemizeResult(data)
  return { clearedClaims: o.clearedClaims, clearedUserIds: o.clearedUserIds, reconfirmUserIds: o.reconfirmUserIds, needsLink: o.needsLink, leftoversCleared: o.leftoversCleared }
}
