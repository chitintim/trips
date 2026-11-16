// Every kind the daily job can email about. The to-dos engine is only a FILTER on these candidates
// (see chaseEngine.ts), so a to-do kind that is not listed here (for example `respond_payment`, the payer's
// "<Receiver> says your £X hasn't arrived") can never produce a reminder email.
export const CHASE_KINDS = [
  'unclaimed_items',
  'unvoted_poll',
  'unfilled_order',
  'pending_rsvp',
  'conditional_date_arrived',
  'waitlist_offer',
  'unpaid_settlement',
  'unconfirmed_settlement',
  't30_no_transport',
  't14_missing_arrival',
  't1_checkin',
  'decision',
  'action_due_7d',
  'action_due_1d',
  'overdue_action',
] as const

export type ChaseKind = (typeof CHASE_KINDS)[number]
