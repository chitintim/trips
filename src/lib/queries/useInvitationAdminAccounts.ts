import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { callRpc } from '../callRpc'
import { queryKeys } from './queryKeys'
import type {
  AdminInvitationAccountAction,
  AdminInvitationAccountRequest,
  AdminInvitationAccountResponse,
} from '../../shared/contracts/adminInvitationAccount'
import type { Invitation } from '../../types'

/**
 * One row of the site-admin Invitations page: an invitation joined to the
 * account it produced, if any. Backed by the get_invitation_admin_details()
 * RPC (supabase/migrations/20260726042921_admin_invitation_account_management.sql)
 * -- admin-only, hard-checked server-side via is_admin() (RAISEs for
 * non-admins, not just a row filter). A superset of the plain `invitations`
 * table columns, so this is the sole data source for that tab's table --
 * see useInvitationAdminDetails below.
 */
export interface InvitationAdminDetail {
  invitation_id: string
  code: string
  trip_id: string
  status: Invitation['status']
  max_uses: number
  current_uses: number
  expires_at: string | null
  invitation_created_at: string
  used_at: string | null
  account_user_id: string | null
  account_full_name: string | null
  account_email: string | null
  account_created_at: string | null
  account_email_confirmed_at: string | null
  account_last_sign_in_at: string | null
}

/**
 * Site-admin Invitations page data: every invitation joined to the account
 * (if any) it produced -- the "why is this account stuck" view. Not yet in
 * the generated Database types (post-codegen RPC, see the migration header
 * comment), so this goes through callRpc rather than supabase.rpc()
 * directly -- see src/lib/callRpc.ts for why that matters (detached-`this`
 * footgun) and for the normalized error shape.
 */
export function useInvitationAdminDetails() {
  return useQuery({
    queryKey: queryKeys.invitationAdminDetails(),
    queryFn: async (): Promise<InvitationAdminDetail[]> => {
      const { data, error } = await callRpc<InvitationAdminDetail[]>('get_invitation_admin_details', {})
      if (error) throw new Error(error.message)
      return data ?? []
    },
  })
}

/**
 * Admin mutations on the account an invitation produced -- resend the
 * confirmation email, correct a typo'd address, manually mark confirmed
 * without sending anything, or fix a display name. Goes through the
 * admin-invitation-account edge function (the only surface allowed to touch
 * auth.users -- re-checks admin status server-side, never trusts a
 * client-supplied flag) rather than any direct table/auth write. Uses the
 * caller's OWN session as the Authorization bearer -- never a service key --
 * same raw-fetch-with-bearer-token pattern as nudgeClient.ts/
 * reorganizeClient.ts (supabase.functions.invoke is avoided elsewhere in
 * this repo for functions that need to distinguish HTTP status codes from
 * the response body; a plain fetch keeps that visible here too).
 */
export function useAdminInvitationAccountAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (request: AdminInvitationAccountRequest): Promise<AdminInvitationAccountResponse> => {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session) throw new Error('Not authenticated')

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-invitation-account`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || !(body as { success?: boolean } | null)?.success) {
        // Surface the edge function's REAL error text verbatim (e.g. the
        // Supabase Admin API's "email_address_invalid" for a typo'd
        // address) -- never collapse this into a generic message. This is
        // the whole point of the admin panel: the real error is exactly
        // what let the motivating stuck-account case go unexplained.
        throw new Error((body as { error?: string } | null)?.error || `Admin action failed (HTTP ${response.status})`)
      }
      return body as AdminInvitationAccountResponse
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.invitationAdminDetails() }),
  })
}

export type { AdminInvitationAccountAction, AdminInvitationAccountRequest, AdminInvitationAccountResponse }
