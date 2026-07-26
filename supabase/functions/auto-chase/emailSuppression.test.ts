/**
 * Unit tests for decideEmailSuppression -- the gate every auto-chase digest
 * (both the opt-in chase kinds and the opt-out action-deadline ladder) is
 * funneled through before sending. The headline case is the opt-out toggle
 * added to ProfileModal: a user who has explicitly turned off email
 * notifications must never receive ANY auto-chase email, regardless of
 * whether an email channel is configured or an address is on file.
 *
 * Run with: deno test supabase/functions/auto-chase/emailSuppression.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@1'
import { decideEmailSuppression } from './emailSuppression.ts'

Deno.test('decideEmailSuppression: sends when channel available, address present, not opted out', () => {
  const result = decideEmailSuppression({
    emailChannelAvailable: true,
    hasEmailAddress: true,
    emailNotificationsEnabled: true,
  })
  assertEquals(result, { canSend: true, skipReason: null })
})

Deno.test('decideEmailSuppression: opted-out user is suppressed even with a working channel and address', () => {
  const result = decideEmailSuppression({
    emailChannelAvailable: true,
    hasEmailAddress: true,
    emailNotificationsEnabled: false,
  })
  assertEquals(result, { canSend: false, skipReason: 'opt_out' })
})

Deno.test('decideEmailSuppression: opt-out takes priority over a missing channel/address (reported reason is opt_out)', () => {
  const result = decideEmailSuppression({
    emailChannelAvailable: false,
    hasEmailAddress: false,
    emailNotificationsEnabled: false,
  })
  assertEquals(result, { canSend: false, skipReason: 'opt_out' })
})

Deno.test('decideEmailSuppression: missing email address is suppressed (no_email), not opted out', () => {
  const result = decideEmailSuppression({
    emailChannelAvailable: true,
    hasEmailAddress: false,
    emailNotificationsEnabled: true,
  })
  assertEquals(result, { canSend: false, skipReason: 'no_email' })
})

Deno.test('decideEmailSuppression: no configured provider is suppressed (no_channel)', () => {
  const result = decideEmailSuppression({
    emailChannelAvailable: false,
    hasEmailAddress: true,
    emailNotificationsEnabled: true,
  })
  assertEquals(result, { canSend: false, skipReason: 'no_channel' })
})

Deno.test('decideEmailSuppression: undefined/null preference (row lookup returned nothing) defaults to NOT opted out', () => {
  assertEquals(
    decideEmailSuppression({ emailChannelAvailable: true, hasEmailAddress: true, emailNotificationsEnabled: null }),
    { canSend: true, skipReason: null }
  )
  assertEquals(
    decideEmailSuppression({
      emailChannelAvailable: true,
      hasEmailAddress: true,
      emailNotificationsEnabled: undefined,
    }),
    { canSend: true, skipReason: null }
  )
})
