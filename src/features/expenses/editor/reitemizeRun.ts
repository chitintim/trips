/**
 * Re-itemising an expense (or turning a plain one into an itemised receipt).
 *
 * Primary path: the database function `reitemize_expense(p_expense_id,
 * p_header, p_lines, p_preview)`. It runs in one transaction under the right
 * permissions, keeps claims on items that did not change and tells us whose
 * claims it cleared. With p_preview = true it writes nothing and answers the
 * same question, which drives the Save-time warning.
 *
 * Fallback, only when the function does not exist yet ("could not find the
 * function"): the old delete-and-reinsert, in the safer order (new lines first,
 * then the old ones, then the header) and clearing EVERY claim, which the
 * editor warns about with a count and names before it gets here.
 *
 * The functions take `db` / `rpc` so they can be unit-tested without a network.
 */
import { isMissingRpc, type RpcError } from '../../../lib/queries/useExpenses'
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

// A loose view of the supabase client: only the chains used below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = { from: (table: string) => any }

export interface ReitemizeArgs {
  expenseId: string
  /** The whole itemised header payload (amount = sum of the lines, status 'unallocated', ...). */
  expense: Record<string, unknown>
  lineItems: ItemizedSaveLine[]
}

/** Refuses, with a plain message, a write the database would reject (zero total, over-long text), on the function path and the fallback alike. */
function assertWritable(args: ReitemizeArgs): void {
  const problem = itemizedWriteProblem(args.expense as { description?: string; vendor_name?: string | null; amount?: number }, args.lineItems)
  if (problem) throw new ReitemizeError(problem)
}

// ---------------------------------------------------------------------------
// Preview (Save time)
// ---------------------------------------------------------------------------

export type ReitemizePreview =
  | { supported: true; outcome: ReitemizeOutcome }
  | { supported: false; claimCount: number; userIds: string[] }

/** Asks what a save would clear, without writing. Before the function exists, reports ALL current claims. */
export async function previewReitemize(db: Db, rpc: RpcFn, args: ReitemizeArgs): Promise<ReitemizePreview> {
  assertWritable(args)
  const { data, error } = await rpc('reitemize_expense', {
    p_expense_id: args.expenseId,
    p_header: toRpcHeader(args.expense),
    p_lines: toRpcLines(args.lineItems),
    p_preview: true,
  })
  if (!error) return { supported: true, outcome: parseReitemizeResult(data) }
  if (!isMissingRpc(error)) throw toReitemizeError(error)
  const { data: claims, error: claimsError } = await db.from('expense_item_claims').select('user_id').eq('expense_id', args.expenseId)
  if (claimsError) throw new ReitemizeError(GENERIC)
  const rows = (claims ?? []) as Array<{ user_id: string }>
  return { supported: false, claimCount: rows.length, userIds: [...new Set(rows.map((r) => r.user_id))] }
}

// ---------------------------------------------------------------------------
// The save
// ---------------------------------------------------------------------------

export interface ReitemizeSaveResult {
  clearedClaims: number
  clearedUserIds: string[]
  reconfirmUserIds: string[]
  /** true = no allocation link exists yet; the caller creates one (false on the fallback path, which looks the link up itself). */
  needsLink: boolean
  leftoversCleared: boolean
  usedFallback: boolean
}

export async function runReitemize(db: Db, rpc: RpcFn, args: ReitemizeArgs): Promise<ReitemizeSaveResult> {
  assertWritable(args)
  const { data, error } = await rpc('reitemize_expense', {
    p_expense_id: args.expenseId,
    p_header: toRpcHeader(args.expense),
    p_lines: toRpcLines(args.lineItems),
    p_preview: false,
  })
  if (!error) {
    const o = parseReitemizeResult(data)
    return { clearedClaims: o.clearedClaims, clearedUserIds: o.clearedUserIds, reconfirmUserIds: o.reconfirmUserIds, needsLink: o.needsLink, leftoversCleared: o.leftoversCleared, usedFallback: false }
  }
  if (!isMissingRpc(error)) throw toReitemizeError(error)
  return { ...(await fallbackReitemize(db, args)), usedFallback: true }
}

/** Line numbers for the new rows: after the highest current one, so they cannot collide with rows that are about to go. */
export function fallbackLineNumbers(currentNumbers: number[], count: number): number[] {
  const start = currentNumbers.length > 0 ? Math.max(...currentNumbers) : 0
  return Array.from({ length: count }, (_, i) => start + i + 1)
}

async function fallbackReitemize(db: Db, args: ReitemizeArgs): Promise<Omit<ReitemizeSaveResult, 'usedFallback'>> {
  const { expenseId, expense, lineItems } = args

  const { data: current, error: currentError } = await db.from('expense_line_items').select('id, line_number').eq('expense_id', expenseId)
  if (currentError) throw new ReitemizeError(GENERIC)
  const oldLines = (current ?? []) as Array<{ id: string; line_number: number }>
  const numbers = fallbackLineNumbers(oldLines.map((l) => l.line_number), lineItems.length)

  // 1. New lines first: if this fails, nothing has been lost.
  const rows = lineItems.map((l, i) => ({
    expense_id: expenseId,
    line_number: numbers[i],
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
  const { data: inserted, error: insertError } = await db.from('expense_line_items').insert(rows).select('id')
  if (insertError) throw new ReitemizeError(GENERIC)
  const newIds = ((inserted ?? []) as Array<{ id: string }>).map((r) => r.id)
  const undoInsert = async () => {
    if (newIds.length > 0) await db.from('expense_line_items').delete().in('id', newIds)
  }

  try {
    // 2. Every claim goes (they all sit on the old lines), then the old lines.
    let clearedUserIds: string[] = []
    let clearedClaims = 0
    if (oldLines.length > 0) {
      const { data: gone, error: claimsError } = await db.from('expense_item_claims').delete().eq('expense_id', expenseId).select('user_id')
      if (claimsError) throw new ReitemizeError(GENERIC)
      const goneRows = (gone ?? []) as Array<{ user_id: string }>
      clearedClaims = goneRows.length
      clearedUserIds = [...new Set(goneRows.map((r) => r.user_id))]

      const oldIds = oldLines.map((l) => l.id)
      const { data: removed, error: removeError } = await db.from('expense_line_items').delete().in('id', oldIds).select('id')
      if (removeError) throw new ReitemizeError(GENERIC)
      if (((removed ?? []) as unknown[]).length < oldIds.length) {
        // Not allowed to remove them (not the payer or an admin): put things back as they were.
        await undoInsert()
        throw new ReitemizeError(MESSAGES.forbidden, 'forbidden')
      }
    }

    // 3. Header last, so the total only changes once the lines are right.
    const { data: updated, error: updateError } = await db.from('expenses').update(expense).eq('id', expenseId).select('id')
    if (updateError || !updated || (updated as unknown[]).length === 0) {
      if (oldLines.length === 0) await undoInsert() // plain expense: leave it plain
      throw new ReitemizeError(updateError ? GENERIC : MESSAGES.forbidden, updateError ? null : 'forbidden')
    }

    // Itemised expenses own their split through lines and claims, not expense_splits.
    const { error: splitsError } = await db.from('expense_splits').delete().eq('expense_id', expenseId)
    if (splitsError) throw new ReitemizeError(GENERIC)

    return { clearedClaims, clearedUserIds, reconfirmUserIds: [], needsLink: false, leftoversCleared: false }
  } catch (err) {
    if (err instanceof ReitemizeError) throw err
    throw new ReitemizeError(GENERIC)
  }
}
