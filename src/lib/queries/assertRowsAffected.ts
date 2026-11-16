/**
 * A bare `.update()`/`.delete()` with no `.select()` reports success even when
 * RLS matches zero rows. Chain `.select(cols)` on the mutation and pass the
 * result here so a blocked/gone target surfaces as an error instead of a
 * silent no-op (same pattern as the expense mutations in useExpenses.ts).
 */
export function assertRowsAffected<T>(rows: T[] | null | undefined, message: string): void {
  if (!rows || rows.length === 0) {
    throw new Error(message)
  }
}

/**
 * Count form of assertRowsAffected, for `.update(values, { count: 'exact' })`
 * WITHOUT `.select()`. Use it when the update itself changes a column the
 * table's SELECT policy depends on (e.g. `active`): a `.select()` adds
 * RETURNING, which makes Postgres require the UPDATED row to pass the SELECT
 * policy, so the write could fail for a row the caller may legitimately edit.
 */
export function assertCountAffected(count: number | null | undefined, message: string): void {
  if (!count || count < 1) {
    throw new Error(message)
  }
}

/**
 * supabase-js returns errors as plain objects (not Error instances), so
 * `err instanceof Error` checks in the UI drop the server's message (e.g. the
 * removal guard's reason, "Voting is closed for this question"). Throw a real
 * Error that carries the server message plus code/hint for callers that care.
 */
export function throwIfError(
  error: { message?: string; code?: string; hint?: string; details?: string } | null | undefined
): asserts error is null | undefined {
  if (!error) return
  const err = new Error(error.message || 'Request failed') as Error & { code?: string; hint?: string; details?: string }
  err.code = error.code
  err.hint = error.hint
  err.details = error.details
  throw err
}
