// Admin Invitation Account Edge Function (NEW): site-admin mutations on the
// account an invitation produced, from the Dashboard's Invitations tab.
//
// auth.users is not exposed via PostgREST and mutating it requires the Auth
// Admin API, which needs the service-role key -- so this is one of the
// narrow, plan-sanctioned service-role surfaces (see _shared/supabaseClients.ts
// header comment): it never reads/writes trip data, only the account record
// tied to an invitation, and only after re-verifying the CALLER is a site
// admin server-side via is_admin() (never a client-supplied flag).
//
// Real motivating case: a user signed up with a typo'd email
// (chrisceungsc123@gmail.com), never confirmed, can't log in, and their
// invitation reads as used/expired with the admin having no way to see why
// or fix it -- get_invitation_admin_details() (20260726042921) surfaces the
// "why"; this function is the "fix it".
//
// Actions (see _shared/contracts/adminInvitationAccount.ts for the request/
// response contract):
//   - resend_confirmation: re-sends the signup confirmation email to the
//     account's CURRENT auth.users email (never a client-supplied address --
//     always re-read server-side so this can't be used to spam an arbitrary
//     inbox). Uses supabase.auth.resend({ type: 'signup' }), which is exactly
//     the "click here to confirm" email GoTrue sends at signup.
//   - update_email: corrects the address on BOTH auth.users (via
//     admin.updateUserById, which keeps the SAME auth user id -- everything
//     keyed off it, trip_participants/trip_actions.assigned_to/votes/
//     completions/avatar, stays attached) and public.users.email (so the
//     app's displayed email matches). Deliberately does NOT pass
//     email_confirm -- GoTrue un-confirms the address on an email change by
//     default, and this function does not override that, so a corrected
//     address always needs an explicit follow-up action (resend_confirmation
//     or confirm_email) -- never silently confirmed as a side effect of
//     fixing a typo. If the Admin API call itself fails (e.g. Supabase's
//     `email_address_invalid` -- what actually happened for the motivating
//     case above with the address as first typed), public.users is left
//     untouched, so the two tables cannot drift out of sync from this path.
//     If auth.users succeeds but the public.users write then fails, this
//     compensates by rolling auth.users back to the prior email rather than
//     leaving the two tables pointing at different addresses.
//   - confirm_email: marks the CURRENT email confirmed without sending
//     anything (admin.updateUserById(..., { email_confirm: true })) --
//     needed precisely because the resend/update path can fail on a bad
//     address, so the admin needs a way to hand-confirm once they've
//     verified the correct address out of band.
//   - update_full_name: public.users.full_name only (trivial -- auth.users
//     has no display-name concept the app reads).
//
// Every action is logged to public.admin_audit_log (service-role write --
// RLS gives that table no INSERT policy for authenticated/anon, only an
// admin-only SELECT) with the acting admin, the target user, and the action.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCorsPreflight } from '../_shared/cors.ts'
import { errorResponse, HttpError, jsonResponse } from '../_shared/errors.ts'
import { callerClient, requireUser, serviceClient } from '../_shared/supabaseClients.ts'
import { AdminInvitationAccountRequestSchema, type AdminInvitationAccountAction } from '../_shared/contracts/adminInvitationAccount.ts'
import { assertIsAdmin } from './adminGate.ts'

interface ActionResult {
  email?: string
  email_confirmed_at?: string | null
  full_name?: string
}

/** Re-sends the signup confirmation email to the account's CURRENT auth.users
 *  email -- always re-read server-side, never trusts a client-supplied address. */
async function resendConfirmation(admin: SupabaseClient, userId: string): Promise<ActionResult> {
  const { data, error: getError } = await admin.auth.admin.getUserById(userId)
  if (getError || !data?.user?.email) {
    throw new HttpError(`Could not load account: ${getError?.message ?? 'no email on file'}`, 404)
  }
  const email = data.user.email
  const { error: resendError } = await admin.auth.resend({ type: 'signup', email })
  if (resendError) {
    throw new HttpError(`Resend failed: ${resendError.message}`, 422)
  }
  return { email }
}

/** Corrects the account's email on BOTH auth.users and public.users, keeping
 *  the same auth user id throughout so trip data stays attached. Does not
 *  auto-confirm -- see header comment. Handles both failure modes explicitly
 *  so the two tables can never end up out of sync from this call. */
async function updateEmail(admin: SupabaseClient, userId: string, newEmail: string): Promise<ActionResult> {
  const { data: before, error: getError } = await admin.auth.admin.getUserById(userId)
  if (getError || !before?.user) {
    throw new HttpError(`Could not load account: ${getError?.message ?? 'user not found'}`, 404)
  }
  const oldEmail = before.user.email ?? null

  const { data: updated, error: authError } = await admin.auth.admin.updateUserById(userId, { email: newEmail })
  if (authError) {
    // auth.users update failed -- untouched, so public.users (still old
    // email) remains in sync. Surface the real Admin API error verbatim
    // (e.g. "email_address_invalid") rather than a generic message.
    throw new HttpError(`Auth update failed: ${authError.message}`, 422)
  }

  const { error: publicError } = await admin.from('users').update({ email: newEmail }).eq('id', userId)
  if (publicError) {
    // auth.users now has the NEW email but public.users still has the OLD
    // one -- compensate by rolling auth.users back rather than leaving a
    // silent mismatch between the two.
    const { error: rollbackError } = await admin.auth.admin.updateUserById(userId, { email: oldEmail ?? undefined })
    if (rollbackError) {
      throw new HttpError(
        `CRITICAL: auth.users email changed to ${newEmail} but public.users update failed ` +
          `(${publicError.message}) AND the rollback to ${oldEmail} also failed (${rollbackError.message}). ` +
          `Manual DB fix required for user ${userId}.`,
        500
      )
    }
    throw new HttpError(
      `public.users update failed (${publicError.message}); auth.users was rolled back to ${oldEmail} to keep the two tables in sync. Nothing changed -- retry.`,
      500
    )
  }

  return { email: newEmail, email_confirmed_at: updated.user?.email_confirmed_at ?? null }
}

/** Marks the current email confirmed without sending anything. */
async function confirmEmail(admin: SupabaseClient, userId: string): Promise<ActionResult> {
  const { data, error } = await admin.auth.admin.updateUserById(userId, { email_confirm: true })
  if (error) {
    throw new HttpError(`Confirm failed: ${error.message}`, 422)
  }
  return { email: data.user?.email ?? undefined, email_confirmed_at: data.user?.email_confirmed_at ?? null }
}

/** public.users.full_name only -- trivial, no auth.users involvement. */
async function updateFullName(admin: SupabaseClient, userId: string, fullName: string): Promise<ActionResult> {
  const { error } = await admin.from('users').update({ full_name: fullName }).eq('id', userId)
  if (error) {
    throw new HttpError(`Name update failed: ${error.message}`, 422)
  }
  return { full_name: fullName }
}

async function runAction(admin: SupabaseClient, action: AdminInvitationAccountAction, userId: string, email?: string, fullName?: string): Promise<ActionResult> {
  switch (action) {
    case 'resend_confirmation':
      return resendConfirmation(admin, userId)
    case 'update_email':
      return updateEmail(admin, userId, email!)
    case 'confirm_email':
      return confirmEmail(admin, userId)
    case 'update_full_name':
      return updateFullName(admin, userId, fullName!)
  }
}

Deno.serve(async (req) => {
  const preflight = handleCorsPreflight(req)
  if (preflight) return preflight

  try {
    // Resolve the CALLER from their own JWT and re-check admin status
    // server-side -- never trust a client-supplied admin flag or user id.
    // is_admin() is the same SECURITY DEFINER helper the get_invitation_
    // admin_details() RPC and the users/site_announcements RLS policies use.
    const caller = callerClient(req)
    const user = await requireUser(caller)
    const { data: isAdmin, error: adminCheckError } = await caller.rpc('is_admin', { p_user_id: user.id })
    if (adminCheckError) {
      throw new HttpError(`Could not verify admin status: ${adminCheckError.message}`, 500)
    }
    assertIsAdmin(isAdmin)

    const request = AdminInvitationAccountRequestSchema.parse(await req.json())

    const admin = serviceClient()
    const result = await runAction(admin, request.action, request.user_id, request.email, request.full_name)

    // Audit trail: best-effort -- a logging failure must not be reported as
    // if the underlying account mutation (which already succeeded) failed.
    const { error: auditError } = await admin.from('admin_audit_log').insert({
      admin_id: user.id,
      action: request.action,
      target_user_id: request.user_id,
      detail: { ...result, request_email: request.email, request_full_name: request.full_name },
    })
    if (auditError) {
      console.error('[admin-invitation-account] audit log insert failed:', auditError)
    }

    return jsonResponse({ success: true, action: request.action, user_id: request.user_id, ...result })
  } catch (error) {
    return errorResponse(error)
  }
})
