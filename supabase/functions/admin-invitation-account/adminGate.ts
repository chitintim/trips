/**
 * Pure admin-gating decision for admin-invitation-account, split into its
 * own module (no Deno.serve / no I/O) so it can be unit tested directly --
 * importing index.ts itself would run its top-level Deno.serve() and leak
 * an open listener under the test resource sanitizer.
 */
import { ForbiddenError } from '../_shared/errors.ts'

/** Only an explicit `true` from the is_admin() RPC passes -- null/false/
 *  undefined (including an RPC call that returned no row) all deny, same as
 *  the RPC's own RAISE EXCEPTION for non-admins. */
export function assertIsAdmin(isAdmin: boolean | null | undefined): void {
  if (isAdmin !== true) {
    throw new ForbiddenError('Site admin required')
  }
}
