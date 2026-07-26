// Per-user email send/suppress decision for the daily digest, extracted from
// index.ts so it's unit-testable without a service-role client (same
// rationale as ./actionDueDate.ts, ./chaseSettings.ts and
// ./outstandingTargets.ts).
//
// This is the ONE place every auto-chase email path funnels through before
// sending: both the opt-in chase kinds (unclaimed items, unvoted polls,
// RSVPs, waitlist, settlements, T-minus nudges) and the opt-OUT
// action-deadline ladder (action_due_7d/action_due_1d/overdue_action) build
// their items into the same per-user `byUser` digest in index.ts, so gating
// happens exactly once per user per run -- there is no separate code path
// that could forget to check this. Account-critical auth emails (signup
// confirmation, password reset) never reach this function at all: they are
// sent directly by Supabase Auth, not by auto-chase.
export interface EmailSuppressionInput {
  /** emailSender.available -- an email provider (Resend/Brevo) is configured server-side. */
  emailChannelAvailable: boolean
  /** users.email is non-null/non-empty for this recipient. */
  hasEmailAddress: boolean
  /** users.email_notifications_enabled -- defaults to true at the DB level, so
   *  only an explicit `false` opts out; null/undefined (shouldn't happen given
   *  the NOT NULL DEFAULT true column, but the row lookup can still fail to
   *  return one) is treated as "not opted out". */
  emailNotificationsEnabled: boolean | null | undefined
}

export type EmailSkipReason = 'opt_out' | 'no_channel' | 'no_email'

export interface EmailSuppressionDecision {
  canSend: boolean
  /** null when canSend is true. */
  skipReason: EmailSkipReason | null
}

export function decideEmailSuppression(input: EmailSuppressionInput): EmailSuppressionDecision {
  if (input.emailNotificationsEnabled === false) {
    return { canSend: false, skipReason: 'opt_out' }
  }
  if (!input.hasEmailAddress) {
    return { canSend: false, skipReason: 'no_email' }
  }
  if (!input.emailChannelAvailable) {
    return { canSend: false, skipReason: 'no_channel' }
  }
  return { canSend: true, skipReason: null }
}
