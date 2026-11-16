import { supabase } from '../supabase'

export type ClaimTodoSource = 'action' | 'checklist'
export type ClaimTodoAction = 'claim' | 'give_back' | 'tick' | 'untick'

interface RpcErrorLike {
  message?: string | null
  code?: string | null
  details?: string | null
  hint?: string | null
}

/**
 * True when the `claim_todo` RPC is not deployed yet (20261117100000_todo_who_mode.sql not applied):
 * PostgREST PGRST202 (not in schema cache), Postgres 42883 (undefined function), or a message naming it.
 */
export function isClaimTodoMissing(error: RpcErrorLike | null | undefined): boolean {
  if (!error) return false
  if (error.code === 'PGRST202' || error.code === '42883') return true
  const text = `${error.message ?? ''} ${error.details ?? ''}`.toLowerCase()
  return text.includes('claim_todo') && (text.includes('could not find') || text.includes('does not exist'))
}

/** A friendly message for an error raised by `claim_todo`. Rule violations carry a safe server message. */
export function claimTodoErrorMessage(error: RpcErrorLike | null | undefined, action: ClaimTodoAction): string {
  if (isClaimTodoMissing(error)) return 'This is not available yet. Please try again later.'
  const msg = (error?.message ?? '').trim()
  // P0001 (rule) and 42501 (permission) are raised by the function with a message written for people.
  if (msg && (error?.code === 'P0001' || error?.code === '42501')) return msg
  switch (action) {
    case 'claim':
      return 'Someone else just took this one, or it is no longer up for grabs.'
    case 'give_back':
      return "You can't give this one back, or it no longer exists."
    default:
      return "You can't update this one, or it no longer exists."
  }
}

export type ClaimTodoResult = { missing: true } | { missing: false }

/**
 * Calls `claim_todo`. Resolves `{ missing: true }` when the RPC is not deployed so the caller can keep the
 * pre-migration behaviour; throws an Error with a friendly message for any other failure.
 */
export async function callClaimTodo(source: ClaimTodoSource, id: string, action: ClaimTodoAction): Promise<ClaimTodoResult> {
  const { error } = await supabase.rpc('claim_todo', { p_source: source, p_id: id, p_action: action })
  if (!error) return { missing: false }
  if (isClaimTodoMissing(error)) return { missing: true }
  const err = new Error(claimTodoErrorMessage(error, action)) as Error & { code?: string }
  err.code = error.code
  throw err
}

/** Probe: does the RPC exist? A made-up id raises a rule error ('no longer exists') when it does. */
export async function claimTodoExists(): Promise<boolean> {
  const { error } = await supabase.rpc('claim_todo', {
    p_source: 'action',
    p_id: '00000000-0000-0000-0000-000000000000',
    p_action: 'claim',
  })
  return !isClaimTodoMissing(error)
}
