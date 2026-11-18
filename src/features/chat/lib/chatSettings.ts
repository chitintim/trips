import { supabase } from '../../../lib/supabase'

/**
 * Site-level and trip-level switches for the trip assistant. The RPCs are newer than the generated database types, so
 * they are called through a narrow structural type and their results are parsed by hand (never trusted blindly).
 * Contract: get_chat_availability / set_trip_chat_settings / admin_get_chat_settings / admin_set_chat_settings.
 */
export type SiteMode = 'off' | 'answers' | 'actions'
export type ActionsScope = 'upcoming' | 'all'
export type TripChatSetting = 'inherit' | 'off'
export type TripActionsSetting = 'inherit' | 'off' | 'on'

export interface ChatAvailability {
  chat: boolean
  actions: boolean
  canManage: boolean
  canForceOn: boolean
  trip: { chat: TripChatSetting; actions: TripActionsSetting }
  site: { mode: SiteMode; actionsScope: ActionsScope }
}

export interface AdminChatTripRow {
  tripId: string
  name: string
  startDate: string | null
  endDate: string | null
  chat: TripChatSetting
  actions: TripActionsSetting
  effectiveChat: boolean
  effectiveActions: boolean
}

export interface AdminChatSettings {
  mode: SiteMode
  actionsScope: ActionsScope
  updatedAt: string | null
  trips: AdminChatTripRow[]
}

export const CHAT_OFF_MESSAGE = 'The assistant is switched off for this trip.'

type RpcError = { code?: string; message?: string } | null
export type RpcFn = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: RpcError }>

const defaultRpc: RpcFn = (name, args) => (supabase.rpc as unknown as RpcFn).call(supabase, name, args)

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null)
const MODES = ['off', 'answers', 'actions'] as const
const SCOPES = ['upcoming', 'all'] as const
const TRIP_CHAT = ['inherit', 'off'] as const
const TRIP_ACTIONS = ['inherit', 'off', 'on'] as const

/** null when the shape is not the contract's (the caller then behaves as if the feature were not there). */
export function parseAvailability(raw: unknown): ChatAvailability | null {
  if (!isObj(raw) || typeof raw.chat !== 'boolean') return null
  const trip = isObj(raw.trip) ? raw.trip : {}
  const site = isObj(raw.site) ? raw.site : {}
  return {
    chat: raw.chat,
    actions: raw.actions === true,
    canManage: raw.can_manage === true,
    canForceOn: raw.can_force_on === true,
    trip: { chat: oneOf(trip.chat, TRIP_CHAT) ?? 'inherit', actions: oneOf(trip.actions, TRIP_ACTIONS) ?? 'inherit' },
    site: { mode: oneOf(site.mode, MODES) ?? 'actions', actionsScope: oneOf(site.actions_scope, SCOPES) ?? 'upcoming' },
  }
}

export function parseAdminSettings(raw: unknown): AdminChatSettings | null {
  const mode = isObj(raw) ? oneOf(raw.mode, MODES) : null
  if (!isObj(raw) || !mode) return null
  const rows = Array.isArray(raw.trips) ? raw.trips : []
  const trips: AdminChatTripRow[] = []
  for (const r of rows) {
    if (!isObj(r) || typeof r.trip_id !== 'string') continue
    trips.push({
      tripId: r.trip_id,
      name: typeof r.name === 'string' ? r.name : 'Untitled trip',
      startDate: typeof r.start_date === 'string' ? r.start_date : null,
      endDate: typeof r.end_date === 'string' ? r.end_date : null,
      chat: oneOf(r.chat, TRIP_CHAT) ?? 'inherit',
      actions: oneOf(r.actions, TRIP_ACTIONS) ?? 'inherit',
      effectiveChat: r.effective_chat === true,
      effectiveActions: r.effective_actions === true,
    })
  }
  return { mode, actionsScope: oneOf(raw.actions_scope, SCOPES) ?? 'upcoming', updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : null, trips }
}

/** What the person gets on a trip, in words. */
export function effectiveLabel(chat: boolean, actions: boolean): 'Off' | 'Answers only' | 'Answers and actions' {
  if (!chat) return 'Off'
  return actions ? 'Answers and actions' : 'Answers only'
}

/**
 * Fail open: while unknown (loading, RPC missing, any error) the assistant is shown as it always was. The server is the
 * authority and still refuses when chat is off.
 */
export const chatIsOn = (a: ChatAvailability | null | undefined): boolean => a?.chat !== false

/** null on any error or an unexpected answer: never throws, so a missing function cannot break the trip page. */
export async function fetchChatAvailability(tripId: string, rpc: RpcFn = defaultRpc): Promise<ChatAvailability | null> {
  try {
    const { data, error } = await rpc('get_chat_availability', { p_trip_id: tripId })
    if (error) return null
    return parseAvailability(data)
  } catch {
    return null
  }
}

async function callOrThrow(rpc: RpcFn, name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await rpc(name, args)
  if (error) throw new Error(error.message || 'Could not save that. Please try again.')
  return data
}

/**
 * Only the field the person changed is sent; the other is NULL, which the server reads as "leave it as it is". Re-sending a value from a
 * stale screen could otherwise undo a change someone else made meanwhile (for example an admin's "force on").
 */
export async function setTripChatSettings(tripId: string, change: { chat?: TripChatSetting; actions?: TripActionsSetting }, rpc: RpcFn = defaultRpc): Promise<ChatAvailability> {
  const parsed = parseAvailability(await callOrThrow(rpc, 'set_trip_chat_settings', { p_trip_id: tripId, p_chat: change.chat ?? null, p_actions: change.actions ?? null }))
  if (!parsed) throw new Error('Could not save that. Please try again.')
  return parsed
}

export async function fetchAdminChatSettings(rpc: RpcFn = defaultRpc): Promise<AdminChatSettings> {
  const parsed = parseAdminSettings(await callOrThrow(rpc, 'admin_get_chat_settings', {}))
  if (!parsed) throw new Error('Could not load the assistant settings.')
  return parsed
}

/** Only the changed field is sent (NULL = unchanged on the server). */
export async function setAdminChatSettings(change: { mode?: SiteMode; actionsScope?: ActionsScope }, rpc: RpcFn = defaultRpc): Promise<AdminChatSettings> {
  const parsed = parseAdminSettings(await callOrThrow(rpc, 'admin_set_chat_settings', { p_mode: change.mode ?? null, p_actions_scope: change.actionsScope ?? null }))
  if (!parsed) throw new Error('Could not save that. Please try again.')
  return parsed
}

/** Which trip-level controls make sense, and why one is switched off. Pure so it can be tested. */
export interface TripControlState {
  chatDisabledReason: string | null
  actionsDisabledReason: string | null
}

export function tripControlState(a: ChatAvailability): TripControlState {
  const siteOff = a.site.mode === 'off'
  return {
    chatDisabledReason: siteOff ? 'Switched off for the whole site.' : null,
    actionsDisabledReason: siteOff
      ? 'Switched off for the whole site.'
      : a.site.mode === 'answers'
        ? 'The site only allows answers, not changes.'
        : a.trip.chat === 'off'
          ? 'Switch the assistant on for this trip first.'
          : null,
  }
}

/** The choices for "let it make changes": organisers can only switch it off or back to following the site; only a site admin can force it on. */
export function actionsChoices(a: Pick<ChatAvailability, 'canForceOn'>): TripActionsSetting[] {
  return a.canForceOn ? ['inherit', 'off', 'on'] : ['inherit', 'off']
}
