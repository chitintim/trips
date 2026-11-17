import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { reportError } from '../reportError'
import { Expense, ExpenseSplit, ExpenseInsert, ExpenseUpdate, User } from '../../types'
import { Tables, TablesInsert } from '../../types/database.types'
import { queryKeys } from './queryKeys'
import { assertRowsAffected } from './assertRowsAffected'
import { toMinorUnits } from '../money'
import { allLinesClaimedWithinDust } from '../../features/expenses/lib/balances'

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
  })
}

/**
 * Convert an EXISTING expense to (or re-edit an already-itemized expense's)
 * itemized split: UPDATEs the expense row in place -- never inserts a new
 * one (that was the bug: the itemized save path always called
 * useCreateItemizedExpense's INSERT regardless of edit mode, so editing an
 * expense and switching it to itemized silently created a duplicate
 * expense instead of converting the one being edited). Also used to
 * re-save an already-itemized expense's line items (e.g. editing a
 * previously-parsed receipt again) -- in that case any existing claims are
 * deleted first, since they reference line_item_id rows that are about to
 * be replaced (the caller is expected to have warned the user via the
 * split-step's claims guard before reaching this point; this is the
 * defensive backstop, not the primary UX).
 */
export function useConvertToItemizedExpense(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      expenseId,
      expense,
      lineItems,
      allocationCode,
      createdBy,
    }: {
      expenseId: string
      expense: ExpenseUpdate
      lineItems: Omit<TablesInsert<'expense_line_items'>, 'expense_id'>[]
      allocationCode: string
      createdBy: string
    }) => {
      const { data: updateRows, error: updateError } = await supabase
        .from('expenses')
        .update(expense)
        .eq('id', expenseId)
        .select('id')
      if (updateError) throw updateError
      assertRowsAffected(updateRows, "You don't have permission to edit this expense, or it no longer exists.")

      // Itemized expenses own their split via line items + claims, not
      // expense_splits -- clear any rows left from a prior equal/custom/
      // percentage/shares split (no-op if there were none).
      const { error: delSplitsError } = await supabase.from('expense_splits').delete().eq('expense_id', expenseId)
      if (delSplitsError) throw delSplitsError

      const { error: delClaimsError } = await supabase.from('expense_item_claims').delete().eq('expense_id', expenseId)
      if (delClaimsError) throw delClaimsError

      const { error: delLineItemsError } = await supabase.from('expense_line_items').delete().eq('expense_id', expenseId)
      if (delLineItemsError) throw delLineItemsError

      if (lineItems.length > 0) {
        const rows: TablesInsert<'expense_line_items'>[] = lineItems.map((item) => ({ expense_id: expenseId, ...item }))
        const { error: lineItemsError } = await supabase.from('expense_line_items').insert(rows)
        if (lineItemsError) throw lineItemsError
      }

      // Reuse the existing allocation link/share-code if one's already
      // out there (re-edit case) rather than minting a second one.
      const { data: existingLink, error: linkFetchError } = await supabase
        .from('expense_allocation_links')
        .select('*')
        .eq('expense_id', expenseId)
        .maybeSingle()
      if (linkFetchError) throw linkFetchError

      if (!existingLink) {
        const { error: linkError } = await supabase.from('expense_allocation_links').insert({
          expense_id: expenseId,
          trip_id: tripId,
          code: allocationCode,
          expires_at: null,
          created_by: createdBy,
        })
        if (linkError) throw linkError
      }

      return { id: expenseId, code: existingLink?.code ?? allocationCode }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.expenses(tripId) }),
  })
}

/**
 * Reverse of the above: convert an itemized expense BACK to a regular
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
  })
}

// ---------------------------------------------------------------------------
// Receipt claims v2: RPC helpers. The functions below are added by the
// receipt-claims migration; the front end may ship before it is applied, so
// every caller probes once (useReceiptRpcSupport) and fails soft.
// ---------------------------------------------------------------------------

interface RpcError {
  code?: string
  message: string
}
async function callRpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: RpcError | null }> {
  const client = supabase as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: RpcError | null }>
  }
  return client.rpc(fn, args)
}

function isMissingRpc(error: RpcError | null): boolean {
  if (!error) return false
  const msg = error.message || ''
  return error.code === 'PGRST202' || error.code === '42883' || error.code === '404' || /could not find the function|does not exist/i.test(msg)
}

function isNetworkError(error: RpcError | null): boolean {
  return !!error && !error.code && /failed to fetch|network|load failed/i.test(error.message || '')
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000'

export interface ReceiptRpcSupport {
  /** `set_receipt_claims` exists: "Who had what", shared claims. */
  setClaims: boolean
  /** `share_receipt_leftovers` exists: the leftovers sheet. */
  leftovers: boolean
}

/**
 * Probes ONCE per session whether the receipt-claims functions exist, by
 * calling each with a nil expense id (it is refused with a normal error when
 * the function exists, and with "could not find the function" when it does
 * not). While the answer is unknown (loading, offline) both read as false, so
 * the new actions stay hidden and today's own-claim behaviour keeps working.
 */
export function useReceiptRpcSupport(): ReceiptRpcSupport {
  const { data } = useQuery({
    queryKey: ['receiptRpcSupport'] as const,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
    queryFn: async (): Promise<ReceiptRpcSupport> => {
      const [a, b] = await Promise.all([
        callRpc('set_receipt_claims', { p_expense_id: NIL_UUID, p_claims: [] }),
        callRpc('share_receipt_leftovers', { p_expense_id: NIL_UUID, p_mode: 'everyone', p_user_id: null, p_preview: true }),
      ])
      if (isNetworkError(a.error) || isNetworkError(b.error)) throw new Error('Could not check receipt claim support')
      return { setClaims: !isMissingRpc(a.error), leftovers: !isMissingRpc(b.error) }
    },
  })
  return data ?? { setClaims: false, leftovers: false }
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
      if (error) throw Object.assign(new Error(error.message), { hint: (error as { hint?: string }).hint, code: (error as { code?: string }).code })
      return data
    },
    onSuccess: (_d, vars) => invalidateReceiptQueries(queryClient, vars.expenseId),
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
}

function normalizeLeftovers(raw: unknown, currency: string): LeftoversResult {
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
  return { shares, totalMinor: minor(obj.unclaimed_total), evenShareMinor: minor(obj.even_share) }
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
export async function previewLeftovers({ expenseId, mode, userId, currency = 'GBP' }: ShareLeftoversArgs): Promise<LeftoversResult> {
  const { data, error } = await callRpc('share_receipt_leftovers', {
    p_expense_id: expenseId,
    p_mode: mode,
    p_user_id: userId ?? null,
    p_preview: true,
  })
  if (error) throw new Error(error.message)
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
      if (error) throw new Error(error.message)
      return normalizeLeftovers(data, currency)
    },
    onSuccess: (_d, vars) => invalidateReceiptQueries(queryClient, vars.expenseId),
  })
}

/**
 * Save a person's OWN item claims (whole-unit steppers) on the claim page.
 * When `lineItemIds` is given only those lines are replaced -- the person's
 * shared / leftover rows on other lines are left alone. Without it, every
 * claim they have on the expense is replaced (the old behaviour). Then
 * recomputes + persists the expense's allocation status.
 *
 * The receipt-claims RPC is for the payer / managers recording who had what
 * for others, and replaces a whole line with an equal share between people, so
 * it cannot express "2 of the 3 beers". A person's own whole-unit claims keep
 * this direct path (allowed by the claims policy for your own rows).
 */
export function useSaveItemClaims() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      expenseId,
      userId,
      claims,
      lineItemIds,
    }: {
      expenseId: string
      userId: string
      claims: Array<Pick<TablesInsert<'expense_item_claims'>, 'line_item_id' | 'quantity_claimed' | 'amount_owed'>>
      lineItemIds?: string[]
    }) => {
      let del = supabase.from('expense_item_claims').delete().eq('expense_id', expenseId).eq('user_id', userId)
      if (lineItemIds) {
        if (lineItemIds.length === 0 && claims.length === 0) return { allClaims: [], status: undefined }
        del = del.in('line_item_id', lineItemIds)
      }
      const { error: delError } = await del
      if (delError) throw delError

      if (claims.length > 0) {
        const rows: TablesInsert<'expense_item_claims'>[] = claims.map((c) => ({
          expense_id: expenseId,
          user_id: userId,
          ...c,
        }))
        const { error: insError } = await supabase.from('expense_item_claims').insert(rows)
        if (insError) throw insError
      }

      const { data: allClaims, error: fetchErr } = await supabase
        .from('expense_item_claims')
        .select('quantity_claimed, line_item_id')
        .eq('expense_id', expenseId)
      if (fetchErr) throw fetchErr

      // The stored status uses the SAME dust-tolerant rule as the claims everywhere else (0.33 x 3 of a line is claimed). The database
      // trigger / check_all_items_claimed compare quantities exactly, so asking them would flip a legacy-thirds receipt back to pending.
      const { data: lines, error: linesErr } = await supabase.from('expense_line_items').select('id, quantity, total_amount').eq('expense_id', expenseId)
      if (linesErr) throw linesErr
      const newStatus = (allClaims ?? []).length === 0 ? 'unallocated' : allLinesClaimedWithinDust(lines ?? [], allClaims ?? []) ? 'allocated' : 'pending_allocation'

      const { data: statusRows, error: statusError } = await supabase
        .from('expenses')
        .update({ status: newStatus })
        .eq('id', expenseId)
        .select('id')
      if (statusError) throw statusError
      assertRowsAffected(statusRows, "You don't have permission to edit this expense, or it no longer exists.")

      return { allClaims, status: newStatus }
    },
    onSuccess: (_data, vars) => invalidateReceiptQueries(queryClient, vars.expenseId),
  })
}
