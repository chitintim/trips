/**
 * Unit tests for the pure logic in admin-invitation-account: the admin-
 * gating decision, request validation against the Zod contract, and error
 * -> HTTP response mapping. Everything that touches the Auth Admin API or
 * the database is exercised separately (empirical SQL security test for the
 * RPC gate; manual verification for the Admin API calls -- see the task
 * report). Run with:
 *   deno test supabase/functions/admin-invitation-account/logic.test.ts
 */
import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { assertIsAdmin } from './adminGate.ts'
import { errorResponse, ForbiddenError, HttpError, UnauthorizedError, ValidationError } from '../_shared/errors.ts'
import { AdminInvitationAccountRequestSchema } from '../_shared/contracts/adminInvitationAccount.ts'

const USER_ID = '11111111-1111-1111-1111-111111111111'

// ---------------------------------------------------------------------------
// Admin gating decision
// ---------------------------------------------------------------------------

Deno.test('assertIsAdmin: true passes silently', () => {
  assertIsAdmin(true)
})

Deno.test('assertIsAdmin: false throws ForbiddenError', () => {
  assertThrows(() => assertIsAdmin(false), ForbiddenError)
})

Deno.test('assertIsAdmin: null (RPC returned no admin row) throws ForbiddenError', () => {
  assertThrows(() => assertIsAdmin(null), ForbiddenError)
})

Deno.test('assertIsAdmin: undefined throws ForbiddenError', () => {
  assertThrows(() => assertIsAdmin(undefined), ForbiddenError)
})

Deno.test('assertIsAdmin: rejection carries a 403 status', () => {
  try {
    assertIsAdmin(false)
    throw new Error('should have thrown')
  } catch (err) {
    assert(err instanceof HttpError)
    assertEquals(err.status, 403)
  }
})

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

Deno.test('request validation: resend_confirmation needs only action + user_id', () => {
  const result = AdminInvitationAccountRequestSchema.safeParse({ action: 'resend_confirmation', user_id: USER_ID })
  assert(result.success)
})

Deno.test('request validation: confirm_email needs only action + user_id', () => {
  const result = AdminInvitationAccountRequestSchema.safeParse({ action: 'confirm_email', user_id: USER_ID })
  assert(result.success)
})

Deno.test('request validation: update_email without email is rejected', () => {
  const result = AdminInvitationAccountRequestSchema.safeParse({ action: 'update_email', user_id: USER_ID })
  assert(!result.success)
  assert(result.error.issues.some((i) => i.path.includes('email')))
})

Deno.test('request validation: update_email with a malformed address is rejected', () => {
  const result = AdminInvitationAccountRequestSchema.safeParse({ action: 'update_email', user_id: USER_ID, email: 'not-an-email' })
  assert(!result.success)
})

Deno.test('request validation: update_email with a valid address is accepted', () => {
  const result = AdminInvitationAccountRequestSchema.safeParse({ action: 'update_email', user_id: USER_ID, email: 'correct@example.com' })
  assert(result.success)
})

Deno.test('request validation: update_full_name without full_name is rejected', () => {
  const result = AdminInvitationAccountRequestSchema.safeParse({ action: 'update_full_name', user_id: USER_ID })
  assert(!result.success)
  assert(result.error.issues.some((i) => i.path.includes('full_name')))
})

Deno.test('request validation: update_full_name with an empty string is rejected (min length)', () => {
  const result = AdminInvitationAccountRequestSchema.safeParse({ action: 'update_full_name', user_id: USER_ID, full_name: '   ' })
  assert(!result.success)
})

Deno.test('request validation: update_full_name with a real name is accepted', () => {
  const result = AdminInvitationAccountRequestSchema.safeParse({ action: 'update_full_name', user_id: USER_ID, full_name: 'Chris Cheung' })
  assert(result.success)
})

Deno.test('request validation: unknown action is rejected', () => {
  const result = AdminInvitationAccountRequestSchema.safeParse({ action: 'delete_account', user_id: USER_ID })
  assert(!result.success)
})

Deno.test('request validation: non-uuid user_id is rejected', () => {
  const result = AdminInvitationAccountRequestSchema.safeParse({ action: 'resend_confirmation', user_id: 'not-a-uuid' })
  assert(!result.success)
})

// ---------------------------------------------------------------------------
// Error -> HTTP response mapping
// ---------------------------------------------------------------------------

Deno.test('errorResponse: ForbiddenError maps to 403 with the success:false envelope', async () => {
  const res = errorResponse(new ForbiddenError('Site admin required'))
  assertEquals(res.status, 403)
  const body = await res.json()
  assertEquals(body, { success: false, error: 'Site admin required' })
})

Deno.test('errorResponse: UnauthorizedError maps to 401', async () => {
  const res = errorResponse(new UnauthorizedError())
  assertEquals(res.status, 401)
})

Deno.test('errorResponse: ValidationError maps to 422', async () => {
  const res = errorResponse(new ValidationError('email is required for update_email'))
  assertEquals(res.status, 422)
})

Deno.test('errorResponse: a custom-status HttpError (e.g. the Admin API failure path) preserves its status and message verbatim', async () => {
  const res = errorResponse(new HttpError('Auth update failed: email_address_invalid', 422))
  assertEquals(res.status, 422)
  const body = await res.json()
  assertEquals(body.error, 'Auth update failed: email_address_invalid')
})

Deno.test('errorResponse: a plain (non-HttpError) Error defaults to 400', () => {
  const res = errorResponse(new Error('boom'))
  assertEquals(res.status, 400)
})

Deno.test('errorResponse: the 500 rollback-failure path preserves its message so the admin sees it needs a manual DB fix', async () => {
  const res = errorResponse(new HttpError('CRITICAL: auth.users email changed but public.users update failed AND rollback failed. Manual DB fix required for user ' + USER_ID, 500))
  assertEquals(res.status, 500)
  const body = await res.json()
  assert(String(body.error).includes('Manual DB fix required'))
})
