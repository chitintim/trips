import { supabase } from '../../../lib/supabase'
import { reportError } from '../../../lib/reportError'
import { AnyAvatarData } from '../../../types'

/**
 * Shared post-auth signup finalization (2026-07 signup-flow bug sweep).
 *
 * Both signup paths -- the in-page OTP/password flow in Signup.tsx and the
 * magic-link callback in AuthCallback.tsx (a user who clicks the emailed
 * link instead of typing the 6-digit code lands there already signed in,
 * having skipped Signup's own finalize step entirely) -- must run the same
 * three writes after the auth user exists:
 *
 *   1. users profile update (name + avatar) -- idempotent, safe to re-run.
 *   2. mark_invitation_used -- may return false if the invitation was
 *      already consumed (including by this same user on a retry).
 *   3. assign_user_to_trip -- only when the invitation targets a trip.
 *
 * Failures are never swallowed: every one is reported via reportError so
 * telemetry fires, and profile/invitation failures are surfaced to the
 * caller as `ok: false` so the UI can show a visible error with a retry
 * instead of silently advancing (the original bug: all three steps
 * console.error'd and continued, leaving accounts with null profiles and
 * unconsumed invitations).
 *
 * The supabase client is injected (structurally typed below) so the
 * decision logic is unit-testable without network -- see
 * finalizeSignup.test.ts.
 */

/** Minimal structural slice of the supabase client this module needs. */
export interface FinalizeClient {
  from(table: 'users'): {
    update(values: Record<string, unknown>): {
      eq(column: 'id', value: string): PromiseLike<{ error: { message: string } | null }>
    }
    select(columns: 'full_name'): {
      eq(column: 'id', value: string): {
        maybeSingle(): PromiseLike<{ data: { full_name: string | null } | null; error: { message: string } | null }>
      }
    }
  }
  rpc(
    fn: 'mark_invitation_used' | 'assign_user_to_trip',
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>
}

export interface FinalizeSignupInput {
  userId: string
  invitationId: string
  tripId: string | null
  /** Column values for the users-row profile update (name + avatar fields). */
  profileUpdate: Record<string, unknown>
}

export interface FinalizeSignupResult {
  /** False when a step the user must not silently lose (profile update or
   * invitation consumption) failed -- the caller should show an error with
   * a retry rather than advancing. */
  ok: boolean
  /** Human-readable messages for the failed fatal steps (empty when ok). */
  errors: string[]
}

export async function finalizeSignup(
  input: FinalizeSignupInput,
  client: FinalizeClient = supabase as unknown as FinalizeClient
): Promise<FinalizeSignupResult> {
  const { userId, invitationId, tripId, profileUpdate } = input
  const errors: string[] = []

  // 1. Profile update. Idempotent, so a retry just rewrites the same
  // values. If it fails but the row already has a full_name (populated by
  // the new-user trigger from the auth signup metadata), tolerate it --
  // the profile isn't actually lost.
  const { error: profileError } = await client.from('users').update(profileUpdate).eq('id', userId)
  if (profileError) {
    reportError(profileError, 'signup:profile-update')
    const { data: existing } = await client.from('users').select('full_name').eq('id', userId).maybeSingle()
    if (!existing?.full_name) {
      errors.push('We couldn’t save your profile.')
    }
  }

  // 2. Consume the invitation. An RPC-level error is fatal (retryable);
  // `false` means the invitation was already used -- on a retry that's this
  // same user, and we can't distinguish who consumed it from the client, so
  // it's reported as a non-fatal warning rather than blocking the account
  // that already exists.
  const { data: invitationMarked, error: invitationError } = await client.rpc('mark_invitation_used', {
    p_invitation_id: invitationId,
    p_user_id: userId,
  })
  if (invitationError) {
    reportError(invitationError, 'signup:mark-invitation-used')
    errors.push('We couldn’t register your invitation.')
  } else if (!invitationMarked) {
    reportError(new Error(`mark_invitation_used returned false for invitation ${invitationId}`), 'signup:invitation-already-used')
  }

  // 3. Trip assignment (best-effort: the account and invitation state are
  // intact either way, and assign_user_to_trip is safe to re-run -- but
  // never silent).
  if (tripId) {
    const { error: assignError } = await client.rpc('assign_user_to_trip', {
      p_invitation_id: invitationId,
      p_user_id: userId,
    })
    if (assignError) reportError(assignError, 'signup:assign-user-to-trip')
  }

  return { ok: errors.length === 0, errors }
}

/**
 * Pending-signup payload persisted to localStorage when the OTP is
 * requested, so a user who completes auth via the emailed magic link
 * (bypassing Signup's in-page verify step) can still be finalized by
 * reconcilePendingSignup below. The photo-avatar File is deliberately
 * absent -- not serializable; those users keep the default avatar and can
 * set a photo from their profile.
 */
export interface PendingSignupPayload {
  invitationId: string
  tripId: string | null
  firstName: string
  lastName: string
  avatarData: AnyAvatarData | null
}

const PENDING_SIGNUP_KEY = 'trips:pending-signup'

export function storePendingSignup(payload: PendingSignupPayload): void {
  try {
    localStorage.setItem(PENDING_SIGNUP_KEY, JSON.stringify(payload))
  } catch {
    // Quota/private-mode failures: the in-page flow still works without it.
  }
}

export function readPendingSignup(): PendingSignupPayload | null {
  try {
    const raw = localStorage.getItem(PENDING_SIGNUP_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingSignupPayload>
    if (typeof parsed.invitationId !== 'string' || typeof parsed.firstName !== 'string' || typeof parsed.lastName !== 'string') {
      return null
    }
    return {
      invitationId: parsed.invitationId,
      tripId: typeof parsed.tripId === 'string' ? parsed.tripId : null,
      firstName: parsed.firstName,
      lastName: parsed.lastName,
      avatarData: (parsed.avatarData as AnyAvatarData | undefined) ?? null,
    }
  } catch {
    return null
  }
}

export function clearPendingSignup(): void {
  try {
    localStorage.removeItem(PENDING_SIGNUP_KEY)
  } catch {
    // Ignore -- worst case the payload lingers until the next reconcile.
  }
}

/** Builds the users-row update for a stored pending payload (mirrors
 * Signup.tsx's finalizeAccount shape, minus the photo branch). */
export function profileUpdateFromPending(pending: PendingSignupPayload): Record<string, unknown> {
  const update: Record<string, unknown> = {
    first_name: pending.firstName,
    last_name: pending.lastName,
    full_name: `${pending.firstName} ${pending.lastName}`,
  }
  if (pending.avatarData) {
    update.avatar_data = pending.avatarData
    update.avatar_url = null
  }
  return update
}

/**
 * Magic-link reconciliation: if a signed-in user has a stored pending
 * signup payload and their users row was never finalized (null full_name),
 * run the same finalize steps the in-page flow would have. Clears the
 * stored payload on success so it can't replay. Returns true when a
 * finalize actually ran and succeeded.
 */
export async function reconcilePendingSignup(
  userId: string,
  client: FinalizeClient = supabase as unknown as FinalizeClient
): Promise<boolean> {
  const pending = readPendingSignup()
  if (!pending) return false

  const { data: row, error: rowError } = await client.from('users').select('full_name').eq('id', userId).maybeSingle()
  if (rowError) {
    reportError(rowError, 'signup:reconcile-profile-check')
    return false
  }
  if (row?.full_name) {
    // Already finalized (e.g. the in-page verify completed) -- just clean up.
    clearPendingSignup()
    return false
  }

  const result = await finalizeSignup(
    {
      userId,
      invitationId: pending.invitationId,
      tripId: pending.tripId,
      profileUpdate: profileUpdateFromPending(pending),
    },
    client
  )
  if (result.ok) clearPendingSignup()
  return result.ok
}
