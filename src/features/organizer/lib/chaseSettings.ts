import type { Json } from '../../../types/database.types'

/**
 * trips.chase_settings jsonb contract, mirrored from the auto-chase edge
 * function (supabase/functions/auto-chase/index.ts). Chase is per-trip
 * OPT-IN: enabled defaults to false.
 */
export interface ChaseSettings {
  enabled: boolean
  delay_hours: number
  quiet_hours: { start: number; end: number } | null
  max_reminders: number
}

export const DEFAULT_CHASE_SETTINGS: ChaseSettings = {
  enabled: false,
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
