import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { actionsEnabledFor, tripIsUpcoming, type TripDates } from './flags.ts'

/**
 * The ONE decision per request: may the assistant answer at all (`chat`), and may it propose confirm-card actions (`actions`).
 * Everything downstream reads this: the propose tools (ctx.actionsEnabled), the capabilities wording in the prompt, begin/gating of
 * actions and `done.actions_enabled`. The handler calls decideChat once per turn, after the caller is known to be on the trip.
 *
 * Source of truth: the database (migration 20261130090000_chat_settings.sql), read with the SERVICE ROLE:
 *   chat_site_settings (one row): mode off | answers | actions, actions_scope upcoming | all
 *   trip_chat_settings (optional row per trip): chat inherit | off, actions inherit | off | on
 *   chat    = mode != off AND trip.chat != off
 *   actions = chat AND mode = actions AND trip.actions != off AND (trip.actions = on OR scope = all OR the trip is upcoming)
 * "upcoming" is flags.ts tripIsUpcoming (reused, not copied), the same rule the SQL function _chat_trip_upcoming implements.
 *
 * Environment (a CEILING, never a floor): TRIP_CHAT_ACTIONS = off | false | 0 switches actions off everywhere whatever the database says
 * (chat itself still follows the database). Any other value, or none, means "the database decides". This is the emergency brake that
 * needs no database access: `supabase secrets set TRIP_CHAT_ACTIONS=off` (takes effect on the next request). To switch the whole
 * assistant off, use the site switch (Admin > Assistant > Off); if the database itself is unreachable, undeploy/redeploy is the only
 * hard stop for chat.
 *
 * FALLBACK (fail to the old behaviour, never crash, never block chat because of a settings problem): when the settings are not
 * readable (migration not applied yet: missing table; any read error; no site row; a value this code does not know) the decision is
 * exactly what it was before this feature: chat on, actions = actionsEnabledFor(env TRIP_CHAT_ACTIONS, trip, dates).
 */
export type ChatDecisionSource = 'db' | 'env'
export interface ChatDecision {
  chat: boolean
  actions: boolean
  source: ChatDecisionSource
  /** Why the fallback was used (only when source = env); for the log line. */
  fallback?: string
}

const OFF_VALUES = new Set(['off', 'false', '0'])
const SITE_MODES = new Set(['off', 'answers', 'actions'])
const SITE_SCOPES = new Set(['upcoming', 'all'])
const TRIP_CHAT = new Set(['inherit', 'off'])
const TRIP_ACTIONS = new Set(['inherit', 'off', 'on'])

/** True when the environment value is an explicit "off" (the ceiling). Unset / empty is NOT a ceiling. */
export function envActionsCeilingOff(flag: string | undefined | null): boolean {
  return OFF_VALUES.has((flag ?? '').trim().toLowerCase())
}

export interface SiteSettings { mode: string; actions_scope: string }
export interface TripSettings { chat: string; actions: string }

/** The pure rule. Returns null when a value is not one this code knows (the caller falls back). */
export function effectiveFromSettings(
  site: SiteSettings, trip: TripSettings | null, tripDates: TripDates | null | undefined, envFlag: string | undefined | null, now: Date = new Date(),
): { chat: boolean; actions: boolean } | null {
  const tc = trip?.chat ?? 'inherit'
  const ta = trip?.actions ?? 'inherit'
  if (!SITE_MODES.has(site.mode) || !SITE_SCOPES.has(site.actions_scope) || !TRIP_CHAT.has(tc) || !TRIP_ACTIONS.has(ta)) return null
  const chat = site.mode !== 'off' && tc !== 'off'
  const actions = chat && site.mode === 'actions' && ta !== 'off' && !envActionsCeilingOff(envFlag)
    && (ta === 'on' || site.actions_scope === 'all' || tripIsUpcoming(tripDates, now))
  return { chat, actions }
}

function envDecision(envFlag: string | undefined, tripId: string, tripDates: TripDates | null | undefined, now: Date, why: string): ChatDecision {
  return { chat: true, actions: actionsEnabledFor(envFlag, tripId, tripDates, now), source: 'env', fallback: why }
}

/**
 * Reads the two settings rows (in parallel: one round trip of latency) and decides. Never throws.
 * `admin` must be the service-role client (the tables have no client policy).
 */
export async function decideChat(
  admin: SupabaseClient, tripId: string, tripDates: TripDates | null | undefined, envFlag: string | undefined, now: Date = new Date(),
): Promise<ChatDecision> {
  try {
    const [siteRes, tripRes] = await Promise.all([
      admin.from('chat_site_settings').select('mode, actions_scope').limit(1).maybeSingle(),
      admin.from('trip_chat_settings').select('chat, actions').eq('trip_id', tripId).maybeSingle(),
    ])
    if (siteRes.error) return envDecision(envFlag, tripId, tripDates, now, `site settings unreadable (${(siteRes.error as { code?: string }).code ?? 'error'})`)
    if (tripRes.error) return envDecision(envFlag, tripId, tripDates, now, `trip settings unreadable (${(tripRes.error as { code?: string }).code ?? 'error'})`)
    const site = siteRes.data as SiteSettings | null
    if (!site) return envDecision(envFlag, tripId, tripDates, now, 'no site settings row')
    const eff = effectiveFromSettings(site, tripRes.data as TripSettings | null, tripDates, envFlag, now)
    if (!eff) return envDecision(envFlag, tripId, tripDates, now, 'unknown settings value')
    return { ...eff, source: 'db' }
  } catch (e) {
    return envDecision(envFlag, tripId, tripDates, now, `settings read threw (${e instanceof Error ? e.name : 'error'})`)
  }
}

/** Thrown by the handler when chat is switched off for this trip; becomes HTTP 403 { error, code: 'chat_off' }. */
export const CHAT_OFF_CODE = 'chat_off'
export const CHAT_OFF_MESSAGE = 'The assistant is switched off for this trip.'
