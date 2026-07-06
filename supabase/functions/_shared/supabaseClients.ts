/**
 * Supabase client factories for edge functions (plan §13 `_shared/` toolkit).
 *
 * Two distinct clients, never conflated:
 *  - callerClient(req): the CALLER's own JWT forwarded in the Authorization
 *    header. RLS applies. Use this for every READ that should be scoped to
 *    what the caller is allowed to see, and for auth.getUser().
 *  - serviceClient(): the service-role key. Bypasses RLS entirely. Use ONLY
 *    for rate limiting, ai_usage logging, and (per plan §14) auto-chase's
 *    scan + notifications writes -- never for reading/writing user data that
 *    should be subject to per-user visibility rules.
 */
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export function getAuthHeader(req: Request): string {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    throw new Error('Missing authorization header')
  }
  return authHeader
}

/** Client scoped to the caller's JWT -- RLS applies. */
export function callerClient(req: Request): SupabaseClient {
  const authHeader = getAuthHeader(req)
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } }
  )
}

/** Service-role client -- bypasses RLS. Use sparingly and document why at each call site. */
export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )
}

/**
 * Verifies the request carries a valid session and returns the authenticated
 * user. Throws on failure -- callers should let this propagate to the
 * top-level error handler (which maps it to a 401).
 */
export async function requireUser(client: SupabaseClient) {
  const { data: { user }, error } = await client.auth.getUser()
  if (error || !user) {
    throw new Error('Unauthorized')
  }
  return user
}

/**
 * Verifies the user is an active participant of the trip. Throws on
 * failure. Uses the existing is_trip_participant(trip_id, user_id) RPC
 * (SECURITY DEFINER, predates the migrations-in-repo policy -- see plan §2).
 */
export async function requireTripParticipant(client: SupabaseClient, tripId: string, userId: string) {
  const { data: isParticipant, error } = await client.rpc('is_trip_participant', {
    p_trip_id: tripId,
    p_user_id: userId,
  })
  if (error) {
    console.error('[requireTripParticipant] RPC error:', error)
    throw new Error('Failed to verify trip membership')
  }
  if (!isParticipant) {
    throw new Error('User is not a participant in this trip')
  }
}

/** Returns whether the user organizes the trip (does not throw). */
export async function isTripOrganizer(client: SupabaseClient, tripId: string, userId: string): Promise<boolean> {
  const { data, error } = await client.rpc('is_trip_organizer', {
    p_trip_id: tripId,
    p_user_id: userId,
  })
  if (error) {
    console.error('[isTripOrganizer] RPC error:', error)
    return false
  }
  return !!data
}
