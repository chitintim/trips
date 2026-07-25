// trips.chase_settings jsonb parsing + gating, extracted from index.ts so
// it's unit-testable without a service-role client (same rationale as
// ./actionDueDate.ts and ./outstandingTargets.ts). Mirrored (by hand, not by
// the contract-drift CI gate -- this pair isn't in
// scripts/check-contract-drift.mjs's MIRROR_PAIRS) in
// src/features/organizer/lib/chaseSettings.ts for the frontend settings UI;
// keep both in sync when the shape changes.
//
// Two independent opt-in/opt-out knobs live in this one jsonb blob:
//   - `enabled` -- the bundled chase kinds (unclaimed items, unvoted polls,
//     pending RSVPs, waitlist offers, unpaid settlements, T-minus nudges).
//     Opt-IN, defaults to false: a trip with chase_settings NULL gets none
//     of these (see the `.not('chase_settings', 'is', null)` filter in
//     index.ts's trip query).
//   - `action_reminders` -- the staged action-deadline ladder
//     (action_due_7d/action_due_1d/overdue_action). Opt-OUT, defaults to
//     true: creating an action with a deadline is itself the opt-in, so
//     these must keep firing for every trip -- including ones with
//     chase_settings NULL -- unless the organizer explicitly turns them
//     off. This default is load-bearing: flipping it would silently stop
//     an important reminder on every existing trip.
export interface ChaseSettings {
  enabled: boolean
  action_reminders: boolean
  delay_hours: number
  quiet_hours: { start: number; end: number } | null
  max_reminders: number
}

export const DEFAULT_SETTINGS: ChaseSettings = {
  enabled: false, // opt-IN per trip: never auto-email trips that haven't turned it on
  action_reminders: true, // opt-OUT: action-deadline reminders run everywhere unless turned off
  delay_hours: 48,
  quiet_hours: null,
  max_reminders: 3,
}

export function parseChaseSettings(raw: unknown): ChaseSettings {
  if (!raw || typeof raw !== 'object') return DEFAULT_SETTINGS
  const r = raw as Record<string, unknown>
  return {
    enabled: r.enabled === true,
    action_reminders: r.action_reminders === false ? false : DEFAULT_SETTINGS.action_reminders,
    delay_hours: typeof r.delay_hours === 'number' ? r.delay_hours : DEFAULT_SETTINGS.delay_hours,
    quiet_hours:
      r.quiet_hours && typeof r.quiet_hours === 'object'
        ? (r.quiet_hours as { start: number; end: number })
        : null,
    max_reminders: typeof r.max_reminders === 'number' ? r.max_reminders : DEFAULT_SETTINGS.max_reminders,
  }
}

export function inQuietHours(settings: ChaseSettings, now: Date): boolean {
  if (!settings.quiet_hours) return false
  const hour = now.getUTCHours()
  const { start, end } = settings.quiet_hours
  // Quiet window may wrap midnight (e.g. 22 -> 8).
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end
}

/**
 * Whether the staged action-deadline ladder should run for this trip right
 * now: `action_reminders` must not be explicitly off, AND quiet hours must
 * not be active. Quiet hours apply here even though `enabled` (the bundled
 * chase kinds) doesn't gate this ladder at all -- see the module doc above.
 */
export function actionRemindersGateOpen(settings: ChaseSettings, now: Date): boolean {
  return settings.action_reminders && !inQuietHours(settings, now)
}
