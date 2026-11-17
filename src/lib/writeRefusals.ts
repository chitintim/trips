/**
 * Plain messages for the database's refusals of money writes (phase 4 hardening), and what to refresh after one.
 *
 * The database refuses with a SQLSTATE `P0001` and a machine `hint`:
 *   - `frozen`  : balances are frozen (a settlement snapshot exists), so expenses, splits, items and claims cannot change;
 *   - `reload`  : this copy of the app is too old to write claims directly (they go through functions now);
 *   - `use_rpc` : a direct write to the freeze columns of a trip (freeze and unfreeze go through Settle up).
 * Older refusals (`claims_closed`, `forbidden`, ...) keep their own wording in the screens that raise them.
 */
import type { QueryClient } from '@tanstack/react-query'
import { queryKeys } from './queries/queryKeys'

export const FROZEN_WRITE_MESSAGE =
  "Balances are frozen while people settle up, so expenses can't be added or changed. An organizer can unfreeze them in Settle up."
export const RELOAD_WRITE_MESSAGE = 'This copy of the app is out of date. Reload the page, then try again.'
export const USE_RPC_WRITE_MESSAGE = 'Freeze and unfreeze balances from Settle up. If you are already there, reload the app and try again.'

const BY_HINT: Record<string, string> = {
  frozen: FROZEN_WRITE_MESSAGE,
  reload: RELOAD_WRITE_MESSAGE,
  use_rpc: USE_RPC_WRITE_MESSAGE,
}

export type RefusalHint = 'frozen' | 'reload' | 'use_rpc'

/** The refusal hint on a thrown value (supabase errors are plain objects, not Errors), or null. */
export function refusalHint(err: unknown): RefusalHint | null {
  const hint = err && typeof err === 'object' ? (err as { hint?: unknown }).hint : null
  return typeof hint === 'string' && hint in BY_HINT ? (hint as RefusalHint) : null
}

/** The plain message for a phase-4 refusal, or null when the error is not one. */
export function refusalMessage(err: unknown): string | null {
  const hint = refusalHint(err)
  return hint ? BY_HINT[hint] : null
}

/** A readable message from whatever was thrown: a refusal's plain message first, then the error's own text. */
export function describeWriteError(err: unknown): string | undefined {
  const refusal = refusalMessage(err)
  if (refusal) return refusal
  if (err instanceof Error) return err.message || undefined
  const m = (err as { message?: unknown } | null)?.message
  return typeof m === 'string' && m ? m : undefined
}

/**
 * After a refused write the screen must show the true state, not what the person tried: refetch the trip (its frozen flag), the
 * expenses, the settlements and any open claim page.
 */
export function refreshAfterRefusal(queryClient: QueryClient, tripId: string | null | undefined, err: unknown): void {
  if (!refusalHint(err)) return
  if (tripId) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.tripDetail(tripId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.expenses(tripId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.settlements(tripId) })
  }
  void queryClient.invalidateQueries({ queryKey: ['claimLink'] })
  void queryClient.invalidateQueries({ queryKey: ['expenseClaims'] })
  void queryClient.invalidateQueries({ queryKey: ['expense'] })
}
