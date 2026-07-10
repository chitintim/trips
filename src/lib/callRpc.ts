import { supabase } from './supabase'
import { reportError } from './reportError'

export interface CallRpcResult<T> {
  data: T | null
  error: { message: string } | null
}

/**
 * Typed wrapper around supabase.rpc() for post-codegen RPCs -- ones the
 * generated Database types don't know about yet (e.g.
 * supabase/migrations/20260710150000_log_invitation_attempt.sql,
 * 20260707130000_invitation_preview.sql).
 *
 * The whole point of this wrapper: SupabaseClient.rpc() is
 * `return this.rest.rpc(...)` internally, so extracting it into a plain
 * function reference (`const rpc = supabase.rpc`) detaches `this` and
 * throws "Cannot read properties of undefined (reading 'rest')" before any
 * network request is made -- this bit production TWICE independently on
 * 2026-07-10 (Signup.tsx's logInvitationAttempt and JoinTrip.tsx's
 * fetchInvitationPreview), and the fix both times was a `.bind(supabase)`
 * plus a warning comment. Comments don't stop a third call site from
 * reintroducing the bug, so callRpc always calls `supabase.rpc(...)` as a
 * direct method call below -- never assigned to an intermediate variable --
 * making the detached-call footgun structurally impossible for any caller
 * that goes through this function instead of rolling its own cast.
 *
 * Also normalizes the result shape: a thrown exception is converted into
 * the same `{ data: null, error }` shape a returned PostgREST error would
 * have, so callers only ever need to check `.error`, never wrap callRpc in
 * their own try/catch. Every failure (thrown or returned) is reported via
 * reportError -- telemetry is additive, callers still get the error back
 * and decide what to do with it.
 *
 * post-codegen RPCs go through callRpc; do not hand-roll bind+cast.
 */
export async function callRpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<CallRpcResult<T>> {
  try {
    const { data, error } = await supabase.rpc(fn as never, args as never)
    if (error) {
      reportError(error, `rpc:${fn}`)
      return { data: null, error: { message: error.message } }
    }
    return { data: data as T, error: null }
  } catch (err) {
    reportError(err, `rpc:${fn}`)
    const message = err instanceof Error ? err.message : String(err)
    return { data: null, error: { message } }
  }
}
