/**
 * Shared types for the trip-chat tools (read + propose). Owned by the turn
 * slice (A3); the read tools (A2) and propose tools (A3) code against it.
 *
 * Rules every tool follows:
 *  - Reads run with ctx.client (the CALLER's JWT), never the service role.
 *  - Reads apply the app's own visibility rules ON TOP of RLS and must never
 *    reveal what the signed-in user could not see in the UI.
 *  - Member-authored text in a result (titles, notes, receipt names, chat) is
 *    wrapped with `tripData(author, text)` so the model treats it as data.
 *  - A propose tool NEVER writes trip data. It validates, then stores one
 *    chat_actions row (service role, via propose/store.ts) and returns ok.
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

/** One person on the trip (trip_participants + users). Includes inactive rows (money only). */
export interface RosterPerson {
  userId: string
  name: string
  role: string | null
  active: boolean
  confirmationStatus: string | null
  /** Only what the reply-standing rule needs (optional: absent = not stated / no live offer). */
  conditionalType?: string | null
  conditionalDate?: string | null
  waitlistOfferExpiresAt?: string | null
}

/** The signed-in user, with the SAME rules as the app's useTripPermissions. */
export interface ChatViewer {
  userId: string
  name: string
  /** admin OR active organiser OR trip creator. */
  canManageTrip: boolean
  isSiteAdmin: boolean
  isOnRoster: boolean
  /** On the roster, active, and not declined/cancelled. */
  isComing: boolean
  /** Declined / cancelled / removed: read-only plus money. */
  isOut: boolean
}

export interface ChatTrip {
  id: string
  name: string
  location: string | null
  start_date: string
  end_date: string
  /** Stored status enum. Never show this to the model or user; use stageWords. */
  status: string
  base_currency: string
  created_by: string | null
  confirmation_enabled: boolean | null
  confirmation_deadline: string | null
  capacity_limit?: number | null
  settlement_snapshot: Json | null
  hide_votes_until_close?: boolean | null
}

export interface ChatActionEnvelope {
  id: string
  kind: string
  params: Json
  preview: Json
  basis: Json
  requires: 'tap' | 'review' | 'link'
  status: string
  expires_at: string | null
  turn_id: string
}

export interface ToolCtx {
  /** Caller's JWT client: RLS applies. */
  client: SupabaseClient
  /** Service-role client: ONLY for writing chat_actions rows. Null in read-only tests. */
  admin: SupabaseClient | null
  tripId: string
  userId: string
  turnId: string
  trip: ChatTrip
  roster: RosterPerson[]
  me: ChatViewer
  /** The one per-request decision (chatSettings.ts: site switch, trip switch, env ceiling; falls back to TRIP_CHAT_ACTIONS via flags.ts when the settings are unreadable). When false every propose tool answers "not switched on" and writes nothing. */
  actionsEnabled: boolean
  /** Today as YYYY-MM-DD in the trip's world (UTC date; the digest says so). */
  today: string
  now: Date
  /** How many actions this turn has already stored (max 5 per turn). */
  proposedThisTurn: { count: number }
  /** Called after a chat_actions row is stored; the server relays it as an SSE `action` event. */
  emitAction: (action: ChatActionEnvelope) => void
  /** Per-turn memo so several tools share one fetch of the same table. */
  memo: Map<string, Promise<unknown>>
  /**
   * OPTIONAL (added by the read tools): this thread's `last_seen_at` as it was BEFORE the current turn marked
   * the thread seen (ISO string), or null when never. When undefined, get_changes reads trip_chat_threads itself.
   */
  lastSeenAt?: string | null
  /**
   * false = the server fell back to the legacy SHARED history (schema not migrated), so the reply is stored where
   * every trip member can read it. Anything only an organiser may see (hidden answers, the waiting-on list) must
   * then NOT be put in the reply. undefined counts as private (tests).
   */
  private?: boolean
  /** The person's own words this turn (used to check dates they stated themselves). */
  userMessage?: string
  /** What the first line of the digest calls the day: 'UTC' or 'your local date'. */
  tzLabel?: string
}

export function memoize<T>(ctx: ToolCtx, key: string, load: () => Promise<T>): Promise<T> {
  let hit = ctx.memo.get(key) as Promise<T> | undefined
  if (!hit) {
    hit = load()
    ctx.memo.set(key, hit)
  }
  return hit
}

export interface ToolResult {
  /** JSON-serialised by the server into the tool_result block. */
  content: unknown
  is_error?: boolean
}

export interface ToolModule {
  name: string
  description: string
  /** Fixed status line for the SSE `status` event. Never model text. */
  statusLabel: string
  /** Hand-written JSON Schema: type object, additionalProperties:false, every property in `required`; optional ones use a nullable type. toolSchema.ts turns this into plain optional parameters for the API (tools are not strict) and maps omitted/null/"" input to null. */
  inputSchema: Record<string, unknown>
  /** Validates raw model input (Zod inside). Throws on bad input: the message goes back as an is_error result. */
  run: (rawInput: unknown, ctx: ToolCtx) => Promise<ToolResult>
}

/** A refusal the model can relay: returned as is_error with plain wording. */
export function refuse(message: string): ToolResult {
  return { content: { ok: false, error: message }, is_error: true }
}

/** Member-authored text goes through this so injected instructions stay data. */
export function tripData(author: string | null, text: string | null | undefined): string {
  const t = (text ?? '').replace(/<\/?trip_data[^>]*>/gi, '')
  return `<trip_data author="${(author ?? 'unknown').replace(/["<>]/g, '')}">${t}</trip_data>`
}

export const MAX_ACTIONS_PER_TURN = 5
