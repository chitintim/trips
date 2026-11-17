import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { reportError } from '../reportError'
import { Expense, ExpenseSplit, ExpenseInsert, ExpenseUpdate, User } from '../../types'
import { Tables, TablesInsert } from '../../types/database.types'
import { queryKeys } from './queryKeys'
import { assertRowsAffected } from './assertRowsAffected'
import { toMinorUnits } from '../money'
import { allLinesClaimedWithinDust } from '../../features/expenses/lib/balances'
import { refreshAfterRefusal } from '../writeRefusals'

export type ExpenseLineItem = Tables<'expense_line_items'>
export type ExpenseItemClaim = Tables<'expense_item_claims'>
export type ExpenseAllocationLink = Tables<'expense_allocation_links'>

export interface ExpenseWithDetails extends Expense {
  payer: User
  splits: Array<ExpenseSplit & { user: User }>
  line_items: ExpenseLineItem[]
  claims: Array<ExpenseItemClaim & { user: Pick<User, 'id' | 'full_name' | 'avatar_url' | 'avatar_data'> }>
  allocation_link: ExpenseAllocationLink | null
  expected_participants: string[]
}

/**
 * Full expenses list for a trip, assembled exactly like ExpensesTab's
 * fetchExpenses: base select with nested payer/splits, then three batched
 * follow-up queries (line items, claims, allocation links) keyed by the
 * itemized expense ids, plus a selections lookup for option-linked expenses
 * and the trip's settlements (so balances can be computed without a second
 * round-trip).
 */
export function useExpenses(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.expenses(tripId || ''),
    queryFn: async (): Promise<{ expenses: ExpenseWithDetails[]; settlements: Tables<'settlements'>[] }> => {
      const { data: expensesData, error } = await supabase
        .from('expenses')
        .select(
          `
          *,
          payer:paid_by (*),
          splits:expense_splits (
            *,
            user:user_id (*)
          )
        `
        )
        .eq('trip_id', tripId as string)
        .order('created_at', { ascending: false })

      if (error) throw error

      const rawExpenses = (expensesData || []) as unknown as ExpenseWithDetails[]

      const itemizedExpenseIds = rawExpenses.filter((e) => e.ai_parsed && e.status).map((e) => e.id)

      const optionIds = [...new Set(rawExpenses.filter((e) => e.option_id).map((e) => e.option_id as string))]

      const emptyResult = <T,>() => Promise.resolve({ data: [] as T[], error: null })
      const [lineItemsRes, claimsRes, linksRes, selectionsRes, settlementsRes] = await Promise.all([
        itemizedExpenseIds.length > 0
          ? supabase.from('expense_line_items').select('*').in('expense_id', itemizedExpenseIds).order('line_number')
          : emptyResult<ExpenseLineItem>(),
        itemizedExpenseIds.length > 0
          ? supabase
              .from('expense_item_claims')
              .select('*, user:users!expense_item_claims_user_id_fkey (id, full_name, avatar_url, avatar_data)')
              .in('expense_id', itemizedExpenseIds)
          : emptyResult<ExpenseItemClaim & { user: Pick<User, 'id' | 'full_name' | 'avatar_url' | 'avatar_data'> }>(),
        itemizedExpenseIds.length > 0
          ? supabase.from('expense_allocation_links').select('*').in('expense_id', itemizedExpenseIds)
          : emptyResult<ExpenseAllocationLink>(),
        optionIds.length > 0
          ? supabase.from('selections').select('option_id, user_id').in('option_id', optionIds)
          : emptyResult<{ option_id: string; user_id: string }>(),
        supabase.from('settlements').select('*').eq('trip_id', tripId as string),
      ])

      const lineItemsByExpense = new Map<string, ExpenseLineItem[]>()
      for (const item of lineItemsRes.data || []) {
        const list = lineItemsByExpense.get(item.expense_id) || []
        list.push(item)
        lineItemsByExpense.set(item.expense_id, list)
      }

      type ClaimWithUser = ExpenseItemClaim & { user: Pick<User, 'id' | 'full_name' | 'avatar_url' | 'avatar_data'> }
      const claimsByExpense = new Map<string, ClaimWithUser[]>()
      for (const claim of (claimsRes.data || []) as ClaimWithUser[]) {
        const list = claimsByExpense.get(claim.expense_id) || []
        list.push(claim)
        claimsByExpense.set(claim.expense_id, list)
      }

      const linkByExpense = new Map<string, ExpenseAllocationLink>()
      for (const link of linksRes.data || []) {
        linkByExpense.set(link.expense_id, link)
      }

      const optionSelections: Record<string, string[]> = {}
      for (const sel of selectionsRes.data || []) {
        if (!optionSelections[sel.option_id]) optionSelections[sel.option_id] = []
        optionSelections[sel.option_id].push(sel.user_id)
      }

      const expenses: ExpenseWithDetails[] = rawExpenses.map((expense) => ({
        ...expense,
        line_items: lineItemsByExpense.get(expense.id) || [],
        claims: claimsByExpense.get(expense.id) || [],
        allocation_link: linkByExpense.get(expense.id) || null,
        expected_participants: expense.option_id ? optionSelections[expense.option_id] || [] : [],
      }))

      if (settlementsRes.error) throw settlementsRes.error

      return { expenses, settlements: (settlementsRes.data || []) as Tables<'settlements'>[] }
    },
    enabled: !!tripId,
  })
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface SplitRow {
  user_id: string
  amount: number
  split_type: ExpenseSplit['split_type']
  percentage?: number | null
  shares?: number | null
  base_currency_amount?: number | null
}

/** Create expense + splits (insert path from AddExpenseModal). */
export function useCreateExpense(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ expense, splits }: { expense: Omit<ExpenseInsert, 'trip_id'>; splits: SplitRow[] }) => {
      const { data: expenseData, error: expenseError } = await supabase
        .from('expenses')
        .insert({ trip_id: tripId, ...expense })
        .select()
        .single()
      if (expenseError) throw expenseError

      if (splits.length > 0) {
        const rows: TablesInsert<'expense_splits'>[] = splits.map((s) => ({ expense_id: expenseData.id, ...s }))
        const { error: splitsError } = await supabase.from('expense_splits').insert(rows)
        if (splitsError) {
          // Roll back the just-created expense so a splits failure can't
          // leave an orphaned expense corrupting zero-sum balances (mirrors
          // applyProposal's create_expense_draft rollback).
          const { error: rollbackError } = await supabase.from('expenses').delete().eq('id', expenseData.id)
          if (rollbackError) reportError(rollbackError, 'useCreateExpense.rollback')
          throw splitsError
        }
      }

      return expenseData
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.expenses(tripId) }),
    onError: (err) => refreshAfterRefusal(queryClient, tripId, err),
  })
}

/**
 * Update expense + upsert splits (edit path). Splits are upserted on
 * (expense_id,user_id) to avoid the unique-constraint violation fixed in
 * commit dcd7ec0 — removed participants are deleted first, current ones
 * upserted, matching AddExpenseModal's edit-mode behavior exactly.
 */
export function useUpdateExpense(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      expenseId,
      expense,
      splits,
      removedUserIds,
      skipSplits,
    }: {
      expenseId: string
      expense: ExpenseUpdate
      splits?: SplitRow[]
      removedUserIds?: string[]
      /** true for itemized expenses, where line items/claims own the split, not this call */
      skipSplits?: boolean
    }) => {
      const { data: updateRows, error: updateError } = await supabase
        .from('expenses')
        .update(expense)
        .eq('id', expenseId)
        .select('id')
      if (updateError) throw updateError
      assertRowsAffected(updateRows, "You don't have permission to edit this expense, or it no longer exists.")

      if (skipSplits) return

      // Upsert the current splits BEFORE deleting removed participants'
      // rows: if the upsert fails, the previous splits are still intact
      // (delete-first left the expense with missing rows -- broken zero-sum
      // -- whenever the subsequent upsert failed). If the later delete
      // fails, the removed participants' old rows temporarily remain and
      // the thrown error prompts a retry -- an over-complete split set is
      // recoverable, an orphaned/partial one silently corrupts balances.
      if (splits && splits.length > 0) {
        const rows: TablesInsert<'expense_splits'>[] = splits.map((s) => ({ expense_id: expenseId, ...s }))
        const { error: splitsError } = await supabase
          .from('expense_splits')
          .upsert(rows, { onConflict: 'expense_id,user_id' })
        if (splitsError) throw splitsError
      }

      if (removedUserIds && removedUserIds.length > 0) {
        const { error: delError } = await supabase
          .from('expense_splits')
          .delete()
          .eq('expense_id', expenseId)
          .in('user_id', removedUserIds)
        if (delError) throw delError
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.expenses(tripId) }),
    onError: (err) => refreshAfterRefusal(queryClient, tripId, err),
  })
}

/** Pending-state (non-optimistic) delete. */
export function useDeleteExpense(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (expenseId: string) => {
      const { data, error } = await supabase.from('expenses').delete().eq('id', expenseId).select('id')
      if (error) throw error
      assertRowsAffected(data, "You don't have permission to delete this expense, or it no longer exists.")
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.expenses(tripId) }),
    onError: (err) => refreshAfterRefusal(queryClient, tripId, err),
  })
}

/**
 * Create an itemized (AI-parsed receipt) expense: expense row (status
 * 'unallocated', ai_parsed true) + line items + a shareable allocation
 * link, with cleanup-on-failure mirroring ItemizedSplitWizard's try/catch
 * rollback (orphaned expense/line-items/link deleted if any step fails).
 */
export function useCreateItemizedExpense(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      expense,
      lineItems,
      allocationCode,
      createdBy,
    }: {
      expense: Omit<ExpenseInsert, 'trip_id'>
      lineItems: Omit<TablesInsert<'expense_line_items'>, 'expense_id'>[]
      allocationCode: string
      createdBy: string
    }) => {
      const { data: expenseData, error: expenseError } = await supabase
        .from('expenses')
        .insert({ trip_id: tripId, ...expense })
        .select()
        .single()
      if (expenseError) throw expenseError

      try {
        const rows: TablesInsert<'expense_line_items'>[] = lineItems.map((item) => ({
          expense_id: expenseData.id,
          ...item,
        }))
        const { error: lineItemsError } = await supabase.from('expense_line_items').insert(rows)
        if (lineItemsError) throw lineItemsError

        const { error: linkError } = await supabase.from('expense_allocation_links').insert({
          expense_id: expenseData.id,
          trip_id: tripId,
          code: allocationCode,
          expires_at: null,
          created_by: createdBy,
        })
        if (linkError) throw linkError
      } catch (innerError) {
        await supabase.from('expense_allocation_links').delete().eq('expense_id', expenseData.id)
        await supabase.from('expense_line_items').delete().eq('expense_id', expenseData.id)
        await supabase.from('expenses').delete().eq('id', expenseData.id)
        throw innerError
      }

      return expenseData
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.expenses(tripId) }),
    onError: (err) => refreshAfterRefusal(queryClient, tripId, err),
  })
}

/**
 * Convert an itemized expense BACK to a regular
 * equal/custom/percentage/shares split. Refuses (throws, so the caller's
 * toast surfaces it) if any items have already been claimed -- silently
 * discarding people's claims would be a correctness bug. The UI is
 * expected to gate this earlier (SplitStep's mode-change guard) so this is
 * the defensive last line, e.g. against a claim landing via the public
 * claim-link page in the moment between the guard check and save.
 */
export function useConvertFromItemizedExpense(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      expenseId,
      expense,
      splits,
    }: {
      expenseId: string
      expense: ExpenseUpdate
      splits: SplitRow[]
    }) => {
      const { data: existingClaims, error: claimsCheckError } = await supabase
        .from('expense_item_claims')
        .select('id')
        .eq('expense_id', expenseId)
        .limit(1)
      if (claimsCheckError) throw claimsCheckError
      if (existingClaims && existingClaims.length > 0) {
        throw new Error('Items on this expense have already been claimed — remove those claims before switching off itemized split.')
      }

      const { data: updateRows, error: updateError } = await supabase
        .from('expenses')
        .update(expense)
        .eq('id', expenseId)
        .select('id')
      if (updateError) throw updateError
      assertRowsAffected(updateRows, "You don't have permission to edit this expense, or it no longer exists.")

      const { error: linkDelError } = await supabase.from('expense_allocation_links').delete().eq('expense_id', expenseId)
      if (linkDelError) throw linkDelError
      const { error: lineItemsDelError } = await supabase.from('expense_line_items').delete().eq('expense_id', expenseId)
      if (lineItemsDelError) throw lineItemsDelError

      if (splits.length > 0) {
        const rows: TablesInsert<'expense_splits'>[] = splits.map((s) => ({ expense_id: expenseId, ...s }))
        const { error: splitsError } = await supabase.from('expense_splits').upsert(rows, { onConflict: 'expense_id,user_id' })
        if (splitsError) throw splitsError
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.expenses(tripId) }),
    onError: (err) => refreshAfterRefusal(queryClient, tripId, err),
  })
}

// ---------------------------------------------------------------------------
// Receipt claims v2: RPC helpers. set_receipt_claims and share_receipt_leftovers
// are live (20261124090000): called directly, no probe. The own-claims function
// (set_my_receipt_claims) is new and still fails soft until its migration is applied.
// ---------------------------------------------------------------------------

export interface RpcError {
  code?: string
  message: string
  hint?: string
}
export async function callRpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: RpcError | null }> {
  const client = supabase as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: RpcError | null }>
  }
  return client.rpc(fn, args)
}

export function isMissingRpc(error: RpcError | null): boolean {
  if (!error) return false
  const msg = error.message || ''
  return error.code === 'PGRST202' || error.code === '42883' || error.code === '404' || /could not find the function|does not exist/i.test(msg)
}

/** A thrown Error that carries the database's `hint` and `code` (the screens map the hint to a plain message). */
export function rpcError(error: RpcError): Error & { hint?: string; code?: string } {
  return Object.assign(new Error(error.message), { hint: error.hint, code: error.code })
}

function invalidateReceiptQueries(queryClient: ReturnType<typeof useQueryClient>, expenseId: string) {
  queryClient.invalidateQueries({ queryKey: ['expenseClaims', expenseId] })
  queryClient.invalidateQueries({ queryKey: ['expense', expenseId] })
  // ClaimPage reads from useClaimLink's ['claimLink', code] cache (we don't
  // have the share code here, so match every entry).
  queryClient.invalidateQueries({ queryKey: ['claimLink'] })
  // Trip expenses (claims included) feed the to-dos, balances and settle-up,
  // so one predicate covers the expenses / settlements / to-do snapshots.
  queryClient.invalidateQueries({
    predicate: (q) =>
      q.queryKey[0] === 'trip' && (q.queryKey[2] === 'expenses' || q.queryKey[2] === 'settlements' || q.queryKey[2] === 'actions'),
  })
}

/** Runs after a claim write succeeds OR is refused: a refusal (frozen, closed, out of date) must show the true state, not the attempt. */
function refreshAfterClaimWrite(queryClient: ReturnType<typeof useQueryClient>, expenseId: string, err: unknown) {
  invalidateReceiptQueries(queryClient, expenseId)
  if (err) {
    void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'trip' && q.queryKey[2] === 'detail' })
  }
}

/** One line's new owners. user_ids = that line shared equally between those people ([] clears it). */
export type ReceiptClaimEntry =
  | { line_item_id: string; user_ids: string[]; shared_by_all?: undefined }
  | { line_item_id: string; shared_by_all: true; user_ids?: undefined }

/**
 * "Who had what": replaces, per listed line, who is paying for it. Lines you
 * do not list are untouched, so sending only the lines that changed is safe
 * to retry. The payer and anyone who can manage the trip may do this for
 * others; anyone may do it for lines they share in.
 */
export function useSetReceiptClaims() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ expenseId, claims }: { expenseId: string; claims: ReceiptClaimEntry[] }) => {
      const { data, error } = await callRpc('set_receipt_claims', { p_expense_id: expenseId, p_claims: claims })
      if (error) throw rpcError(error)
      return data
    },
    onSettled: (_d, err, vars) => refreshAfterClaimWrite(queryClient, vars.expenseId, err),
  })
}

/** `same` repeats the last mode used for this receipt (re-run after someone edits their claims). */
export type LeftoverMode = 'everyone' | 'person' | 'payer' | 'same'

export interface LeftoverShare {
  userId: string
  /** What this person is charged from the leftovers, minor units. */
  amountMinor: number
  /** What they had already claimed, minor units (when the server says). */
  alreadyClaimedMinor: number | null
  /** Their total on the receipt afterwards, minor units (when the server says). */
  totalAfterMinor: number | null
}
export interface LeftoversResult {
  shares: LeftoverShare[]
  /** Unclaimed value being placed, minor units. */
  totalMinor: number | null
  /** An even share of the bill, minor units, when the server says. */
  evenShareMinor: number | null
  /** The one person who gets all of it (`person` / `payer` mode), when the server says (the apply preview does). */
  leftoverUserId?: string | null
}

export function normalizeLeftovers(raw: unknown, currency: string): LeftoversResult {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const minor = (v: unknown): number | null => (typeof v === 'number' ? toMinorUnits(v, currency) : null)
  const shares: LeftoverShare[] = []
  if (Array.isArray(obj.people)) {
    for (const item of obj.people as Array<Record<string, unknown>>) {
      const userId = item.user_id as string | undefined
      if (!userId) continue
      shares.push({
        userId,
        amountMinor: minor(item.amount) ?? 0,
        alreadyClaimedMinor: minor(item.already_claimed),
        totalAfterMinor: minor(item.total_after),
      })
    }
  }
  const leftoverUserId = typeof obj.leftover_user_id === 'string' && obj.leftover_user_id ? obj.leftover_user_id : null
  return { shares, totalMinor: minor(obj.unclaimed_total), evenShareMinor: minor(obj.even_share), leftoverUserId }
}

export interface ShareLeftoversArgs {
  expenseId: string
  mode: LeftoverMode
  /** Required for mode 'person'. */
  userId?: string | null
  /** Currency of the expense, to read amounts the server sends in major units. */
  currency?: string
}

/** Preview of who would get what (writes nothing). */
async function previewLeftovers({ expenseId, mode, userId, currency = 'GBP' }: ShareLeftoversArgs): Promise<LeftoversResult> {
  const { data, error } = await callRpc('share_receipt_leftovers', {
    p_expense_id: expenseId,
    p_mode: mode,
    p_user_id: userId ?? null,
    p_preview: true,
  })
  if (error) throw rpcError(error)
  return normalizeLeftovers(data, currency)
}

/** Query wrapper for the preview, used by the leftovers sheet. */
export function useLeftoversPreview(args: ShareLeftoversArgs | null) {
  return useQuery({
    queryKey: ['leftoversPreview', args?.expenseId, args?.mode, args?.userId ?? null] as const,
    queryFn: () => previewLeftovers(args as ShareLeftoversArgs),
    enabled: !!args && (args.mode !== 'person' || !!args.userId),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })
}

/**
 * Places a receipt's unclaimed value on people for real (payer / managers).
 * `mutateAsync({ expenseId, mode: 'everyone' | 'person' | 'payer', userId? })`
 * resolves to the same shape the preview returns. Used by the leftovers sheet
 * and by the Freeze dialog.
 */
export function useShareLeftovers() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ expenseId, mode, userId, currency = 'GBP' }: ShareLeftoversArgs): Promise<LeftoversResult> => {
      const { data, error } = await callRpc('share_receipt_leftovers', {
        p_expense_id: expenseId,
        p_mode: mode,
        p_user_id: userId ?? null,
        p_preview: false,
      })
      if (error) throw rpcError(error)
      return normalizeLeftovers(data, currency)
    },
    onSettled: (_d, err, vars) => refreshAfterClaimWrite(queryClient, vars.expenseId, err),
  })
}

/** One line of `set_my_receipt_claims`: the caller's own whole-unit quantity on that line (0 takes them off it). */
export interface OwnClaimLine {
  line_item_id: string
  quantity: number
}

/**
 * The lines to send to `set_my_receipt_claims`: every line the person touched (`lineItemIds`) with the quantity they now hold there
 * (0 = take them off). The server works out what it costs; the client sends quantities only.
 */
export function buildOwnClaimLines(
  claims: ReadonlyArray<{ line_item_id: string; quantity_claimed: number }>,
  lineItemIds: ReadonlyArray<string>
): OwnClaimLine[] {
  const qty = new Map<string, number>()
  for (const c of claims) qty.set(c.line_item_id, (qty.get(c.line_item_id) ?? 0) + c.quantity_claimed)
  return [...new Set([...lineItemIds, ...qty.keys()])].map((id) => ({ line_item_id: id, quantity: qty.get(id) ?? 0 }))
}

/**
 * `set_my_receipt_claims` is new: until its migration is applied the call answers "could not find the function". That answer is
 * remembered for the session so later saves go straight to the old direct path (no failed round trip each time).
 */
let ownClaimsRpcMissing = false
/** Test hook. */
export function resetOwnClaimsRpcCache() {
  ownClaimsRpcMissing = false
}

type SaveItemClaimsVars = {
  expenseId: string
  userId: string
  claims: Array<Pick<TablesInsert<'expense_item_claims'>, 'line_item_id' | 'quantity_claimed' | 'amount_owed'>>
  /** The lines being replaced (shared and leftover rows on other lines are left alone). */
  lineItemIds: string[]
}

/** The old path, kept only for the rollout window before `set_my_receipt_claims` is live: client-computed amounts, direct writes. */
async function saveItemClaimsDirect({ expenseId, userId, claims, lineItemIds }: SaveItemClaimsVars) {
  if (lineItemIds.length === 0 && claims.length === 0) return { allClaims: [], status: undefined }
  const { error: delError } = await supabase.from('expense_item_claims').delete().eq('expense_id', expenseId).eq('user_id', userId).in('line_item_id', lineItemIds)
  if (delError) throw delError

  if (claims.length > 0) {
    const rows: TablesInsert<'expense_item_claims'>[] = claims.map((c) => ({ expense_id: expenseId, user_id: userId, ...c }))
    const { error: insError } = await supabase.from('expense_item_claims').insert(rows)
    if (insError) throw insError
  }

  const { data: allClaims, error: fetchErr } = await supabase.from('expense_item_claims').select('quantity_claimed, line_item_id').eq('expense_id', expenseId)
  if (fetchErr) throw fetchErr

  // The stored status uses the SAME dust-tolerant rule as the claims everywhere else (0.33 x 3 of a line is claimed). The database
  // trigger / check_all_items_claimed compare quantities exactly, so asking them would flip a legacy-thirds receipt back to pending.
  const { data: lines, error: linesErr } = await supabase.from('expense_line_items').select('id, quantity, total_amount').eq('expense_id', expenseId)
  if (linesErr) throw linesErr
  const newStatus = (allClaims ?? []).length === 0 ? 'unallocated' : allLinesClaimedWithinDust(lines ?? [], allClaims ?? []) ? 'allocated' : 'pending_allocation'

  const { data: statusRows, error: statusError } = await supabase.from('expenses').update({ status: newStatus }).eq('id', expenseId).select('id')
  if (statusError) throw statusError
  assertRowsAffected(statusRows, "You don't have permission to edit this expense, or it no longer exists.")
  return { allClaims, status: newStatus }
}

/**
 * Save a person's OWN whole-unit claims (the steppers on the claim page). Only the lines in `lineItemIds` are replaced.
 *
 * Primary path: `set_my_receipt_claims(p_expense_id, p_lines)`. The database computes what each unit costs, keeps any leftover part on
 * the row, takes the locks and applies the frozen / closed / overclaim rules, then refreshes the receipt status. A refusal comes back
 * as `hint` (frozen, claims_closed, ...) and nothing is changed.
 *
 * Fallback, only while that function does not exist yet: the previous direct writes with client-computed amounts. Remove it once the
 * migration is applied.
 *
 * Whether the save works or is refused, the claim page, expenses, balances and to-dos are refetched so the screen shows the true state.
 */
export function useSaveItemClaims() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (vars: SaveItemClaimsVars) => {
      if (!ownClaimsRpcMissing) {
        const lines = buildOwnClaimLines(vars.claims, vars.lineItemIds)
        if (lines.length === 0) return { allClaims: [], status: undefined, viaRpc: true as const }
        const { error } = await callRpc('set_my_receipt_claims', { p_expense_id: vars.expenseId, p_lines: lines })
        if (!error) return { allClaims: undefined, status: undefined, viaRpc: true as const }
        if (!isMissingRpc(error)) throw rpcError(error)
        ownClaimsRpcMissing = true
      }
      return { ...(await saveItemClaimsDirect(vars)), viaRpc: false as const }
    },
    onSettled: (_data, err, vars) => refreshAfterClaimWrite(queryClient, vars.expenseId, err),
  })
}
