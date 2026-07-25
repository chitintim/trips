import type { Json } from '../../../types/database.types'

/**
 * trips.chase_settings jsonb contract, mirrored from the auto-chase edge
 * function (supabase/functions/auto-chase/chaseSettings.ts -- NOT covered
 * by scripts/check-contract-drift.mjs's MIRROR_PAIRS, so keep the two
 * copies in sync by hand when this shape changes).
 *
 * Two independent knobs:
 *   - `enabled` -- the bundled chase kinds (unclaimed items, unvoted polls,
 *     pending RSVPs, waitlist offers, unpaid settlements). OPT-IN, defaults
 *     to false: nobody is emailed about these until the organizer turns
 *     this on.
 *   - `action_reminders` -- the staged action-deadline ladder (7 days
 *     before / 1 day before / overdue, for any action with a deadline).
 *     OPT-OUT, defaults to true: creating an action with a deadline is
 *     itself the opt-in, so this runs on every trip -- independent of
 *     `enabled` -- unless the organizer explicitly turns it off.
 */
export interface ChaseSettings {
  enabled: boolean
  action_reminders: boolean
  delay_hours: number
  quiet_hours: { start: number; end: number } | null
  max_reminders: number
}

export const DEFAULT_CHASE_SETTINGS: ChaseSettings = {
  enabled: false,
  action_reminders: true,
  delay_hours: 48,
  quiet_hours: null,
  max_reminders: 3,
}

export function parseChaseSettings(raw: Json | null | undefined): ChaseSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_CHASE_SETTINGS
  const r = raw as Record<string, unknown>
  const quiet = r.quiet_hours
  return {
    enabled: r.enabled === true,
    action_reminders: r.action_reminders === false ? false : DEFAULT_CHASE_SETTINGS.action_reminders,
    delay_hours: typeof r.delay_hours === 'number' ? r.delay_hours : DEFAULT_CHASE_SETTINGS.delay_hours,
    quiet_hours:
      quiet && typeof quiet === 'object' && !Array.isArray(quiet) &&
      typeof (quiet as Record<string, unknown>).start === 'number' &&
      typeof (quiet as Record<string, unknown>).end === 'number'
        ? { start: (quiet as { start: number }).start, end: (quiet as { end: number }).end }
        : null,
    max_reminders: typeof r.max_reminders === 'number' ? r.max_reminders : DEFAULT_CHASE_SETTINGS.max_reminders,
  }
}
