/**
 * Data hooks for the claims v2 experience: resolving a public claim link by
 * its share code (no dedicated query hook exists in src/lib/queries for
 * this lookup direction), and the live claims realtime channel ported from
 * the legacy ClaimItemsPage pattern.
 */
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../../lib/supabase'
import type { RealtimeChannel } from '@supabase/supabase-js'
import type { ExpenseLineItem, ExpenseItemClaim } from '../../../lib/queries/useExpenses'
import type { Expense, User } from '../../../types'

export interface ClaimLinkResolution {
  expense: Expense
  lineItems: ExpenseLineItem[]
  claims: Array<ExpenseItemClaim & { user: Pick<User, 'id' | 'full_name' | 'avatar_data'> }>
  tripId: string
  code: string
  expiresAt: string | null
}

/** Resolves a public claim link (/claim/:code) to its expense + line items + claims. */
export function useClaimLink(code: string | undefined) {
  return useQuery({
    queryKey: ['claimLink', code] as const,
    queryFn: async (): Promise<ClaimLinkResolution | null> => {
      const { data: link, error: linkError } = await supabase
        .from('expense_allocation_links')
        .select('*')
        .eq('code', code as string)
        .single()
      if (linkError) throw linkError
      if (!link) return null

      const [{ data: expense, error: expenseError }, { data: lineItems, error: lineItemsError }, { data: claims, error: claimsError }] =
        await Promise.all([
          supabase.from('expenses').select('*').eq('id', link.expense_id).single(),
          supabase.from('expense_line_items').select('*').eq('expense_id', link.expense_id).order('line_number'),
          supabase
            .from('expense_item_claims')
            .select('*, user:user_id (id, full_name, avatar_data)')
            .eq('expense_id', link.expense_id),
        ])

      if (expenseError) throw expenseError
      if (lineItemsError) throw lineItemsError
      if (claimsError) throw claimsError

      return {
        expense: expense as Expense,
        lineItems: lineItems || [],
        claims: (claims || []) as ClaimLinkResolution['claims'],
        tripId: link.trip_id,
        code: link.code,
        expiresAt: link.expires_at,
      }
    },
    enabled: !!code,
  })
}

export interface LiveSelectionPayload {
  userId: string
  userName: string
  selections: Record<string, { lineItemId: string; quantity: number; amount: number }>
}

/**
 * Live claim realtime channel, porting the legacy ClaimItemsPage pattern:
 * channel `expense_claims:${expenseId}`, `broadcast: {self:false}`, two
 * event sources -- `postgres_changes` on expense_item_claims (persisted
 * saves, triggers a refetch) and a `broadcast` `selection_change` event
 * (live unsaved edits from other viewers, merged optimistically client-side
 * without touching the DB). Returns the live peer selections map plus a
 * `broadcastSelection` sender for this client's own in-progress edits.
 */
export function useClaimRealtime(expenseId: string | undefined, currentUserId: string | undefined, currentUserName: string) {
  const queryClient = useQueryClient()
  const [peerSelections, setPeerSelections] = useState<Record<string, LiveSelectionPayload>>({})
  const channelRef = useRef<RealtimeChannel | null>(null)

  useEffect(() => {
    if (!expenseId) return

    const channel = supabase.channel(`expense_claims:${expenseId}`, { config: { broadcast: { self: false } } })

    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'expense_item_claims', filter: `expense_id=eq.${expenseId}` },
      () => {
        queryClient.invalidateQueries({ queryKey: ['claimLink'] })
        queryClient.invalidateQueries({ queryKey: ['expenseClaims', expenseId] })
      }
    )

    channel.on('broadcast', { event: 'selection_change' }, ({ payload }) => {
      const data = payload as LiveSelectionPayload
      if (data.userId === currentUserId) return
      setPeerSelections((prev) => ({ ...prev, [data.userId]: data }))
    })

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') channelRef.current = channel
    })

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        queryClient.invalidateQueries({ queryKey: ['claimLink'] })
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      channelRef.current = null
      supabase.removeChannel(channel)
    }
  }, [expenseId, currentUserId, queryClient])

  const broadcastSelection = (selections: LiveSelectionPayload['selections']) => {
    if (!channelRef.current || !currentUserId) return
    channelRef.current.send({
      type: 'broadcast',
      event: 'selection_change',
      payload: { userId: currentUserId, userName: currentUserName, selections } as LiveSelectionPayload,
    })
  }

  return { peerSelections, broadcastSelection }
}
