import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { Expense, ExpenseSplit, ExpenseInsert, ExpenseUpdate, User } from '../../types'
import { Tables, TablesInsert } from '../../types/database.types'
import { queryKeys } from './queryKeys'

export type ExpenseLineItem = Tables<'expense_line_items'>
export type ExpenseItemClaim = Tables<'expense_item_claims'>
export type ExpenseAllocationLink = Tables<'expense_allocation_links'>

export interface ExpenseWithDetails extends Expense {
  payer: User
  splits: Array<ExpenseSplit & { user: User }>
  line_items: ExpenseLineItem[]
  claims: Array<ExpenseItemClaim & { user: Pick<User, 'id' | 'full_name' | 'avatar_data'> }>
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
              .select('*, user:user_id (id, full_name, avatar_data)')
              .in('expense_id', itemizedExpenseIds)
          : emptyResult<ExpenseItemClaim & { user: Pick<User, 'id' | 'full_name' | 'avatar_data'> }>(),
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

      type ClaimWithUser = ExpenseItemClaim & { user: Pick<User, 'id' | 'full_name' | 'avatar_data'> }
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

/** Single expense by id (detail view / edit prefill / claim page). */
export function useExpense(expenseId: string | undefined) {
  return useQuery({
    queryKey: ['expense', expenseId] as const,
    queryFn: async (): Promise<Expense | null> => {
      const { data, error } = await supabase.from('expenses').select('*').eq('id', expenseId as string).single()
      if (error) throw error
      return data
    },
    enabled: !!expenseId,
  })
}

export function useExpenseLineItems(expenseId: string | undefined) {
  return useQuery({
    queryKey: ['expenseLineItems', expenseId] as const,
    queryFn: async (): Promise<ExpenseLineItem[]> => {
      const { data, error } = await supabase
        .from('expense_line_items')
        .select('*')
        .eq('expense_id', expenseId as string)
        .order('line_number')
      if (error) throw error
      return data || []
    },
    enabled: !!expenseId,
  })
}

export function useExpenseClaims(expenseId: string | undefined) {
  return useQuery({
    queryKey: ['expenseClaims', expenseId] as const,
    queryFn: async (): Promise<ExpenseItemClaim[]> => {
      const { data, error } = await supabase.from('expense_item_claims').select('*').eq('expense_id', expenseId as string)
      if (error) throw error
      return data || []
    },
    enabled: !!expenseId,
  })
}

export function useExpenseSplits(expenseId: string | undefined) {
  return useQuery({
    queryKey: ['expenseSplits', expenseId] as const,
    queryFn: async (): Promise<ExpenseSplit[]> => {
      const { data, error } = await supabase.from('expense_splits').select('*').eq('expense_id', expenseId as string)
      if (error) throw error
      return data || []
    },
    enabled: !!expenseId,
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
        if (splitsError) throw splitsError
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
      const { error: updateError } = await supabase.from('expenses').update(expense).eq('id', expenseId)
      if (updateError) throw updateError

      if (skipSplits) return

      if (removedUserIds && removedUserIds.length > 0) {
        const { error: delError } = await supabase
          .from('expense_splits')
          .delete()
          .eq('expense_id', expenseId)
          .in('user_id', removedUserIds)
        if (delError) throw delError
      }

      if (splits && splits.length > 0) {
        const rows: TablesInsert<'expense_splits'>[] = splits.map((s) => ({ expense_id: expenseId, ...s }))
        const { error: splitsError } = await supabase
          .from('expense_splits')
          .upsert(rows, { onConflict: 'expense_id,user_id' })
        if (splitsError) throw splitsError
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
      const { error } = await supabase.from('expenses').delete().eq('id', expenseId)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.expenses(tripId) }),
  })
}

/** Claim/unclaim itemized receipt line items (upsert on (line_item_id,user_id) semantics via delete+insert). */
export function useUpsertItemClaim(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (claim: TablesInsert<'expense_item_claims'>) => {
      const { error } = await supabase.from('expense_item_claims').upsert(claim, { onConflict: 'line_item_id,user_id' })
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.expenses(tripId) }),
  })
}

export function useDeleteItemClaim(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (claimId: string) => {
      const { error } = await supabase.from('expense_item_claims').delete().eq('id', claimId)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.expenses(tripId) }),
  })
}

export function useCreateAllocationLink(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: TablesInsert<'expense_allocation_links'>) => {
      const { data, error } = await supabase.from('expense_allocation_links').insert(input).select().single()
      if (error) throw error
      return data
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
      const { error: updateError } = await supabase.from('expenses').update(expense).eq('id', expenseId)
      if (updateError) throw updateError

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

      const { error: updateError } = await supabase.from('expenses').update(expense).eq('id', expenseId)
      if (updateError) throw updateError

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

/**
 * Save a claimer's item claims on the public claim-link page: replace
 * their existing claims for this expense, then recompute + persist the
 * expense's allocation status ('allocated' when every item is fully
 * claimed, else 'pending_allocation'). Mirrors ClaimItemsPage's save flow.
 */
export function useSaveItemClaims() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      expenseId,
      userId,
      claims,
    }: {
      expenseId: string
      userId: string
      claims: Array<Pick<TablesInsert<'expense_item_claims'>, 'line_item_id' | 'quantity_claimed' | 'amount_owed'>>
    }) => {
      const { error: delError } = await supabase
        .from('expense_item_claims')
        .delete()
        .eq('expense_id', expenseId)
        .eq('user_id', userId)
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

      const { data: allItemsClaimed } = await supabase.rpc('check_all_items_claimed', { p_expense_id: expenseId })
      const newStatus = allItemsClaimed ? 'allocated' : 'pending_allocation'

      const { error: statusError } = await supabase.from('expenses').update({ status: newStatus }).eq('id', expenseId)
      if (statusError) throw statusError

      return { allClaims, status: newStatus }
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['expenseClaims', vars.expenseId] })
      queryClient.invalidateQueries({ queryKey: ['expense', vars.expenseId] })
      // ClaimPage/ClaimMatrix actually read from useClaimLink's
      // ['claimLink', code] cache, not ['expense', ...] -- without this,
      // a user's OWN successful save only refreshed their own screen's
      // available/maxQty numbers via the realtime postgres_changes
      // side-channel (useClaimData.ts), which is fragile if realtime lags
      // or is briefly disconnected. Partial key match invalidates every
      // ['claimLink', *] entry (we don't have the share code here).
      queryClient.invalidateQueries({ queryKey: ['claimLink'] })
    },
  })
}

/** Bulk FX-rate refresh across an expense list (mirrors ExpensesTab's "Update FX rates" action). */
export function useUpdateExpenseFxRate(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      expenseId,
      baseCurrencyAmount,
      fxRate,
      fxRateDate,
    }: {
      expenseId: string
      baseCurrencyAmount: number
      fxRate: number
      fxRateDate: string
    }) => {
      const { error } = await supabase
        .from('expenses')
        .update({ base_currency_amount: baseCurrencyAmount, fx_rate: fxRate, fx_rate_date: fxRateDate })
        .eq('id', expenseId)
      if (error) throw error

      const { data: splits } = await supabase.from('expense_splits').select('id, amount').eq('expense_id', expenseId)
      if (splits) {
        await Promise.all(
          splits.map((split) =>
            supabase.from('expense_splits').update({ base_currency_amount: split.amount * fxRate }).eq('id', split.id)
          )
        )
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.expenses(tripId) }),
  })
}
