/**
 * Receipts phase 2, signed-in side: send a receipt to the table, extend / apply its deadline, reply "That's everything" /
 * "I wasn't there", and the trip's email switch. Every probe fails soft: until the migration and functions exist, the
 * support hooks say no and nothing here is called.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { queryKeys } from './queryKeys'
import { callRpc, isMissingRpc, normalizeLeftovers, type LeftoversResult, type RpcError } from './useExpenses'
import {
  NO_RPC_SUPPORT,
  deadlinePassed,
  sendOutcomeFrom,
  type ReceiptTableRpcSupport,
  type SendOutcome,
} from '../../features/expenses/claims/receiptTable'

const NIL_UUID = '00000000-0000-0000-0000-000000000000'

function isNetworkError(error: RpcError | null): boolean {
  return !!error && !error.code && /failed to fetch|network|load failed/i.test(error.message || '')
}

/**
 * Probes ONCE per session which phase-2 database functions exist (a nil expense id is refused normally when the function is
 * there and with "could not find the function" when it is not). Unknown (loading, offline) reads as "none".
 */
export function useReceiptTableRpcSupport(): ReceiptTableRpcSupport {
  const { data } = useQuery({
    queryKey: ['receiptTableRpcSupport'] as const,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
    queryFn: async (): Promise<ReceiptTableRpcSupport> => {
      const [send, extend, apply, reopen, respond] = await Promise.all([
        callRpc('send_receipt_to_table', { p_expense_id: NIL_UUID, p_deadline: null }),
        callRpc('extend_receipt_deadline', { p_expense_id: NIL_UUID, p_deadline: new Date().toISOString() }),
        callRpc('apply_receipt_deadline', { p_expense_id: NIL_UUID, p_preview: true }),
        callRpc('reopen_receipt_claims', { p_expense_id: NIL_UUID, p_deadline: null }),
        callRpc('respond_to_receipt', { p_expense_id: NIL_UUID, p_response: 'undo' }),
      ])
      if ([send, extend, apply, reopen, respond].some((r) => isNetworkError(r.error))) throw new Error('Could not check receipt deadline support')
      return { send: !isMissingRpc(send.error), extend: !isMissingRpc(extend.error), apply: !isMissingRpc(apply.error), reopen: !isMissingRpc(reopen.error), respond: !isMissingRpc(respond.error) }
    },
  })
  return data ?? NO_RPC_SUPPORT
}

/** Everything a receipt's deadline, replies and to-dos are built from: refresh it all. */
export function invalidateReceiptTable(queryClient: QueryClient, tripId: string, expenseId: string) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.expenses(tripId) }) // includes ['..','expenses','claimResponses']
  void queryClient.invalidateQueries({ queryKey: ['claimLink'] })
  void queryClient.invalidateQueries({ queryKey: ['expenseClaims', expenseId] })
  void queryClient.invalidateQueries({ queryKey: ['expense', expenseId] })
  void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'trip' && q.queryKey[1] === tripId && (q.queryKey[2] === 'settlements' || q.queryKey[2] === 'actions') })
}

function rpcError(error: RpcError): Error {
  return Object.assign(new Error(error.message), { hint: error.hint, code: error.code })
}

async function readErrorBody(error: unknown): Promise<{ status: number | null; body: unknown }> {
  const ctx = (error as { context?: unknown } | null)?.context as Response | undefined
  const status = typeof ctx?.status === 'number' ? ctx.status : null
  try {
    return { status, body: await ctx?.clone?.().json?.() }
  } catch {
    return { status, body: null }
  }
}

/** "Done — send to the table": the `receipt-notice` function sets the deadline (via the RPC as the caller) and emails people. Never throws. */
export function useSendToTable(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ expenseId, deadline, resendUserIds }: { expenseId: string; deadline?: string | null; resendUserIds?: string[] }): Promise<SendOutcome> => {
      try {
        const { data, error } = await supabase.functions.invoke('receipt-notice', {
          // `resend_user_ids`: people whose claims re-itemising cleared; the function emails them again even if they had the first email
          // (caps are enforced server-side).
          body: { expense_id: expenseId, event: 'send_to_table', ...(deadline ? { deadline } : {}), ...(resendUserIds?.length ? { resend_user_ids: resendUserIds } : {}) },
        })
        if (!error) return sendOutcomeFrom(200, data)
        const { status, body } = await readErrorBody(error)
        return sendOutcomeFrom(status, body)
      } catch {
        return sendOutcomeFrom(null, null)
      }
    },
    onSettled: (_d, _e, vars) => invalidateReceiptTable(queryClient, tripId, vars.expenseId),
  })
}

/** Moves the deadline (payer / managers). No email goes out. */
export function useExtendDeadline(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ expenseId, deadline }: { expenseId: string; deadline: string }) => {
      const { data, error } = await callRpc('extend_receipt_deadline', { p_expense_id: expenseId, p_deadline: deadline })
      if (error) throw rpcError(error)
      return data
    },
    onSuccess: (_d, vars) => invalidateReceiptTable(queryClient, tripId, vars.expenseId),
  })
}

/**
 * "Share the rest now", preview: the database runs the real path in a rolled-back sub-transaction (`apply_receipt_deadline` with
 * `p_preview`), so this is exactly who will be charged what when it is confirmed. Nothing is written.
 */
export function useApplyPreview(args: { expenseId: string; currency: string } | null) {
  return useQuery({
    queryKey: ['applyDeadlinePreview', args?.expenseId] as const,
    queryFn: async (): Promise<LeftoversResult> => {
      const { data, error } = await callRpc('apply_receipt_deadline', { p_expense_id: (args as { expenseId: string }).expenseId, p_preview: true })
      if (error) throw rpcError(error)
      const skipped = (data as { skipped?: unknown } | null)?.skipped
      if (skipped === 'not_itemised') throw Object.assign(new Error("This expense isn't split by item any more."), { hint: 'not_itemised' })
      return normalizeLeftovers(data, (args as { currency: string }).currency)
    },
    enabled: !!args,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })
}

/** "Share the rest now": applies the deadline rule today and closes the receipt (payer / managers). */
export function useApplyDeadline(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ expenseId }: { expenseId: string }) => {
      const { data, error } = await callRpc('apply_receipt_deadline', { p_expense_id: expenseId })
      if (error) throw rpcError(error)
      return data
    },
    onSuccess: (_d, vars) => invalidateReceiptTable(queryClient, tripId, vars.expenseId),
  })
}

/**
 * Reopens a closed receipt (payer / managers, not on frozen trips): the leftover parts go, every answer stays, and the deadline is the one
 * picked (null = the server default, 3 days at 18:00 UTC). Nothing is emailed.
 */
export function useReopenClaims(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ expenseId, deadline }: { expenseId: string; deadline?: string | null }) => {
      const { data, error } = await callRpc('reopen_receipt_claims', { p_expense_id: expenseId, p_deadline: deadline ?? null })
      if (error) throw rpcError(error)
      return data
    },
    onSuccess: (_d, vars) => invalidateReceiptTable(queryClient, tripId, vars.expenseId),
  })
}

/**
 * Your own reply through `respond_to_receipt`: "done" / "not_there", or `null` to take it back ("undo"). The database takes the locks and
 * applies every rule (frozen, closed, deadline, payer, own items, leftovers); its reason comes back as `hint`.
 */
export function useReplyToReceipt(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ expenseId, response, deadline }: { expenseId: string; userId?: string; response: 'done' | 'not_there' | null; deadline?: string | null }) => {
      // Same as the public page: nothing changes once the reply-by time has gone (the database refuses it too).
      if (deadlinePassed(deadline, new Date())) throw Object.assign(new Error('The time to reply has passed.'), { hint: 'deadline_passed' })
      const { data, error } = await callRpc('respond_to_receipt', { p_expense_id: expenseId, p_response: response ?? 'undo' })
      if (error) throw rpcError(error)
      return data
    },
    onSettled: (_d, _e, vars) => invalidateReceiptTable(queryClient, tripId, vars.expenseId),
  })
}

/** The trip's "send emails for receipts" switch (organizers). */
export function useSetReceiptNotices(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      const client = supabase as unknown as {
        from: (t: string) => { update: (v: Record<string, unknown>) => { eq: (c: string, v: string) => { select: (c: string) => Promise<{ data: unknown[] | null; error: RpcError | null }> } } }
      }
      const { data, error } = await client.from('trips').update({ receipt_notices_enabled: enabled }).eq('id', tripId).select('id')
      if (error) throw rpcError(error)
      if (!data || data.length === 0) throw new Error('Could not save: you may not have permission to change this.')
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tripDetail(tripId) })
    },
  })
}
