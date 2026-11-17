import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../../lib/supabase'
import { parseEnvelope, type ChatActionEnvelope } from './payload'

/**
 * Thin, fail-soft wrappers over the chat tables / functions added by the chat_actions and private-thread migrations.
 * They are not in the generated database types yet, so the client is used through a narrow structural type.
 * Before the migrations are applied every read here answers "nothing there" and the chat behaves exactly as it did.
 */
export interface DbError {
  message: string
  code?: string
  hint?: string
}
type Result = { data: unknown; error: DbError | null }
type Chain = PromiseLike<Result> & {
  eq(column: string, value: string): Chain
  order(column: string, options: { ascending: boolean }): Chain
  limit(n: number): Chain
}
export interface LooseClient {
  from(table: string): { select(columns: string): Chain }
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<Result>
}

const defaultClient = (): LooseClient => supabase as unknown as LooseClient

/** The RPC is not deployed yet (PostgREST: function not found / not in the schema cache). */
export function isMissingObject(error: DbError | null | undefined): boolean {
  if (!error) return false
  return error.code === 'PGRST202' || error.code === 'PGRST205' || error.code === '42P01' || error.code === '42883' || /could not find the (function|table)/i.test(error.message)
}

// ---------------------------------------------------------------------------
// Plain wording for the chat bookkeeping errors (hints from the DB note)
// ---------------------------------------------------------------------------
export const DAILY_CAP_MESSAGE = "You've confirmed a lot today — try again tomorrow."
export const GONE_MESSAGE = "That suggestion isn't available any more."
export const CHAT_RPC_MISSING_MESSAGE = 'Confirming from chat is not switched on yet.'

export function describeChatRpcError(error: DbError | null | undefined): string {
  if (!error) return 'Something went wrong. Please try again.'
  if (isMissingObject(error)) return CHAT_RPC_MISSING_MESSAGE
  switch (error.hint) {
    case 'daily_cap':
      return DAILY_CAP_MESSAGE
    case 'not_found':
      return GONE_MESSAGE
    case 'forbidden':
      return "You're no longer on this trip, so this can't go ahead."
    case 'auth':
      return 'Please sign in again, then try once more.'
    case 'not_started':
      return 'This one has not been started yet. Please try again.'
    default:
      return 'Something went wrong. Please try again.'
  }
}

/** A failure of one of the bookkeeping RPCs, carrying the plain message. */
export class ChatRpcError extends Error {
  readonly hint: string | null
  readonly missing: boolean
  constructor(error: DbError) {
    super(describeChatRpcError(error))
    this.name = 'ChatRpcError'
    this.hint = error.hint ?? null
    this.missing = isMissingObject(error)
  }
}

async function callRpc(client: LooseClient, fn: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await client.rpc(fn, args)
  if (error) throw new ChatRpcError(error)
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
}

export type BeginResult = { started: true; action: ChatActionEnvelope | null } | { started: false; reason: 'already_started' | 'expired' | 'not_proposed'; action: ChatActionEnvelope | null }
export type FinishResult = { finished: boolean; reason: string | null; action: ChatActionEnvelope | null }
export type DismissResult = { dismissed: boolean; reason: string | null; action: ChatActionEnvelope | null }

export interface ChatRpc {
  begin(id: string): Promise<BeginResult>
  finish(id: string, ok: boolean, result?: Record<string, unknown> | null, error?: string | null): Promise<FinishResult>
  dismiss(id: string): Promise<DismissResult>
  markEdited(id: string, result?: Record<string, unknown> | null): Promise<{ marked: boolean; reason: string | null; action: ChatActionEnvelope | null }>
  /** Record on the server that the person undid it (so every device stops offering Undo). Needs the `mark_chat_action_undone` RPC; best effort. */
  markUndone?(id: string): Promise<void>
}

export function makeChatRpc(client: LooseClient = defaultClient()): ChatRpc {
  return {
    async begin(id) {
      const r = await callRpc(client, 'begin_chat_action', { p_id: id })
      const action = parseEnvelope(r.action)
      if (r.started === true) return { started: true, action }
      const reason = r.reason === 'expired' || r.reason === 'not_proposed' ? r.reason : 'already_started'
      return { started: false, reason, action }
    },
    async finish(id, ok, result = null, error = null) {
      const r = await callRpc(client, 'finish_chat_action', { p_id: id, p_ok: ok, p_result: result, p_error: error })
      return { finished: r.finished === true, reason: typeof r.reason === 'string' ? r.reason : null, action: parseEnvelope(r.action) }
    },
    async dismiss(id) {
      const r = await callRpc(client, 'dismiss_chat_action', { p_id: id })
      return { dismissed: r.dismissed === true, reason: typeof r.reason === 'string' ? r.reason : null, action: parseEnvelope(r.action) }
    },
    async markUndone(id) {
      try {
        await callRpc(client, 'mark_chat_action_undone', { p_id: id })
      } catch {
        /* not deployed yet: this device still remembers it */
      }
    },
    async markEdited(id, result = null) {
      const r = await callRpc(client, 'mark_chat_action_edited', { p_id: id, p_result: result })
      return { marked: r.marked === true, reason: typeof r.reason === 'string' ? r.reason : null, action: parseEnvelope(r.action) }
    },
  }
}

/** "New chat": stop replaying older turns to the model. Resolves with the new cut-off, or null when private threads are not live yet. */
export async function startNewChat(tripId: string, client: LooseClient = defaultClient()): Promise<string | null> {
  const { data, error } = await client.rpc('new_chat', { p_trip_id: tripId })
  if (error) {
    if (isMissingObject(error)) return null
    throw new ChatRpcError(error)
  }
  const at = (data as { cleared_at?: unknown } | null)?.cleared_at
  return typeof at === 'string' ? at : new Date().toISOString()
}

/** Best effort: remember that the person has looked at the chat. Never throws. */
export async function markChatSeen(tripId: string, client: LooseClient = defaultClient()): Promise<void> {
  try {
    await client.rpc('mark_chat_seen', { p_trip_id: tripId })
  } catch {
    /* bookkeeping only */
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export const chatActionsKey = (tripId: string) => ['trip', tripId, 'chatActions'] as const
export const chatThreadKey = (tripId: string, userId: string) => ['trip', tripId, 'chatThread', userId] as const

/** My proposed actions on this trip, oldest first. Any failure (table not there yet, offline) is "none". */
export async function fetchChatActions(tripId: string, client: LooseClient = defaultClient()): Promise<ChatActionEnvelope[]> {
  try {
    const { data, error } = await client.from('chat_actions').select('*').eq('trip_id', tripId).order('created_at', { ascending: true })
    if (error || !Array.isArray(data)) return []
    return data.map(parseEnvelope).filter((a): a is ChatActionEnvelope => !!a)
  } catch {
    return []
  }
}

export function useChatActions(tripId: string | undefined) {
  return useQuery({
    queryKey: chatActionsKey(tripId || ''),
    queryFn: () => fetchChatActions(tripId as string),
    enabled: !!tripId,
    staleTime: 15_000,
  })
}

export interface ChatThreadInfo {
  /** The private-thread tables exist (the migration is applied). */
  available: boolean
  /** Messages at or before this time are hidden after "New chat". */
  clearedAt: string | null
}

export async function fetchThreadInfo(tripId: string, userId: string, client: LooseClient = defaultClient()): Promise<ChatThreadInfo> {
  try {
    const { data, error } = await client.from('trip_chat_threads').select('cleared_at').eq('trip_id', tripId).eq('user_id', userId).limit(1)
    if (error) return { available: false, clearedAt: null }
    const row = Array.isArray(data) ? (data[0] as { cleared_at?: unknown } | undefined) : undefined
    return { available: true, clearedAt: typeof row?.cleared_at === 'string' ? row.cleared_at : null }
  } catch {
    return { available: false, clearedAt: null }
  }
}

export function useChatThreadInfo(tripId: string | undefined, userId: string | undefined) {
  return useQuery({
    queryKey: chatThreadKey(tripId || '', userId || ''),
    queryFn: () => fetchThreadInfo(tripId as string, userId as string),
    enabled: !!tripId && !!userId,
    staleTime: 60_000,
  })
}

