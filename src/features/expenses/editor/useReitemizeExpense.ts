import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../../lib/supabase'
import { callRpc } from '../../../lib/queries/useExpenses'
import { invalidateReceiptTable } from '../../../lib/queries/useReceiptTable'
import type { ItemizedSaveLine } from '../itemized/itemizedState'
import { previewReitemize, runReitemize, ReitemizeError, type Db, type ReitemizePreview, type ReitemizeSaveResult } from './reitemizeRun'

export interface ReitemizeParams {
  expenseId: string
  /** The whole itemised header payload. */
  expense: Record<string, unknown>
  lineItems: ItemizedSaveLine[]
  allocationCode: string
  createdBy: string
}

export interface ReitemizeResult extends ReitemizeSaveResult {
  id: string
  code: string
}

const db = supabase as unknown as Db

/** What a save would clear, asked at Save time (writes nothing). */
export function previewReitemizeExpense(params: Pick<ReitemizeParams, 'expenseId' | 'expense' | 'lineItems'>): Promise<ReitemizePreview> {
  return previewReitemize(db, callRpc, params)
}

/**
 * Re-itemise an existing expense, or turn a plain one into an itemised receipt.
 * Uses the `reitemize_expense` database function (claims on unchanged items
 * survive); until that function exists, falls back to replacing every line and
 * clearing every claim. See reitemizeRun.ts.
 */
export function useReitemizeExpense(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ expenseId, expense, lineItems, allocationCode, createdBy }: ReitemizeParams): Promise<ReitemizeResult> => {
      const saved = await runReitemize(db, callRpc, { expenseId, expense, lineItems })

      // Reuse the existing share code if there is one. The database says when there is none (`needs_link`) and then the code made here is
      // used, as the create path does; on the fallback path (no `needs_link` answer) the link is looked up.
      let existingLink: { code: string } | null = null
      if (!saved.needsLink) {
        const { data: found, error: linkFetchError } = await supabase.from('expense_allocation_links').select('*').eq('expense_id', expenseId).maybeSingle()
        if (linkFetchError) throw new ReitemizeError("The receipt was saved, but we couldn't open its share link. Try again.")
        existingLink = found
      }
      if (!existingLink) {
        const { error: linkError } = await supabase.from('expense_allocation_links').insert({
          expense_id: expenseId,
          trip_id: tripId,
          code: allocationCode,
          expires_at: null,
          created_by: createdBy,
        })
        if (linkError) throw new ReitemizeError("The receipt was saved, but we couldn't open its share link. Try again.")
      }
      return { ...saved, id: expenseId, code: existingLink?.code ?? allocationCode }
    },
    // The claim page reads outside the trip expenses prefix (['claimLink', code], ['expenseClaims', id], ['expense', id]), and the to-dos
    // and balances live under 'actions' / 'settlements': refresh all of them so the claim page never shows the old items or total.
    onSuccess: (_result, vars) => invalidateReceiptTable(queryClient, tripId, vars.expenseId),
  })
}
