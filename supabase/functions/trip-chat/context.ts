/**
 * Everything the turn needs to know before it calls the model: the trip, the
 * roster, who the asker is (same rules as the app's useTripPermissions), the
 * private thread history, and the per-turn personal digest (proposal 4.6).
 *
 * Cache layout: tools -> system[0] static -> system[1] trip block -> history
 * (one breakpoint on its last block) -> the [Context] digest + the user's
 * words as separate blocks of the current turn (never cached).
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import type { AnthropicContentBlock, AnthropicMessage } from '../_shared/anthropic.ts'
import { isMissingSchemaError } from '../_shared/todos/snapshot.ts'
import type { ChatTrip, ChatViewer, RosterPerson, ToolCtx } from './tools/types.ts'
import { tripData } from './tools/types.ts'
import { computeMyMoneyLine, computeMyTodoDigest, questionsNeedingMyAnswer } from './tools/read/index.ts'

export const HISTORY_TURNS = 12
/**
 * The replayed window slides in STEPS, not one message at a time. Rows are numbered from the start of the thread
 * (after "new chat"); the window starts at a multiple of HISTORY_STEP_ROWS, so its first message is the same for
 * 6 turns in a row and the cached prefix survives (a one-message slide would change the first byte every turn).
 * Size: HISTORY_TURNS*2 rows right after a step, up to HISTORY_TURNS*2 + HISTORY_STEP_ROWS - 1 just before the next.
 */
export const HISTORY_STEP_ROWS = 12
export const HISTORY_MAX_ROWS = HISTORY_TURNS * 2 + HISTORY_STEP_ROWS
/** Hard bound on the replayed text (about 15k tokens). Oldest messages are dropped first. */
export const HISTORY_MAX_CHARS = 60_000

/** First row index of the window for a thread with `total` rows (pure; exported for tests). */
export function historyWindowStart(total: number): number {
  const keep = HISTORY_TURNS * 2
  return total <= keep ? 0 : Math.floor((total - keep) / HISTORY_STEP_ROWS) * HISTORY_STEP_ROWS
}

export async function loadTripAndRoster(client: SupabaseClient, tripId: string, userId: string): Promise<{ trip: ChatTrip; roster: RosterPerson[]; viewer: ChatViewer }> {
  const [tripRes, rosterRes, userRes] = await Promise.all([
    client.from('trips').select('id, name, location, start_date, end_date, status, base_currency, created_by, confirmation_enabled, confirmation_deadline, capacity_limit, settlement_snapshot').eq('id', tripId).single(),
    client.from('trip_participants').select('user_id, role, active, confirmation_status, conditional_type, conditional_date, waitlist_offer_expires_at, user:user_id(full_name, email)').eq('trip_id', tripId),
    client.from('users').select('full_name, email, role').eq('id', userId).maybeSingle(),
  ])
  if (tripRes.error || !tripRes.data) throw new Error('Trip not found')
  const trip = tripRes.data as unknown as ChatTrip
  // deno-lint-ignore no-explicit-any
  const roster: RosterPerson[] = ((rosterRes.data ?? []) as any[]).map((p) => ({
    userId: p.user_id,
    name: p.user?.full_name || p.user?.email || 'Someone',
    role: p.role ?? null,
    active: p.active !== false,
    confirmationStatus: p.confirmation_status ?? null,
    conditionalType: p.conditional_type ?? null,
    conditionalDate: p.conditional_date ?? null,
    waitlistOfferExpiresAt: p.waitlist_offer_expires_at ?? null,
  }))
  return { trip, roster, viewer: computeViewer(userId, userRes.data as { full_name?: string; email?: string; role?: string } | null, trip, roster) }
}

/** Same rules as src/hooks/useTripPermissions: canManageTrip = site admin OR active organiser OR creator. */
export function computeViewer(userId: string, user: { full_name?: string | null; email?: string | null; role?: string | null } | null, trip: Pick<ChatTrip, 'created_by'>, roster: RosterPerson[]): ChatViewer {
  const mine = roster.find((p) => p.userId === userId)
  const isSiteAdmin = user?.role === 'admin'
  const isOrganiser = !!mine && mine.active && mine.role === 'organizer'
  const out = !mine || !mine.active || mine.confirmationStatus === 'declined' || mine.confirmationStatus === 'cancelled'
  return {
    userId,
    name: user?.full_name || user?.email || mine?.name || 'You',
    canManageTrip: isSiteAdmin || isOrganiser || trip.created_by === userId,
    isSiteAdmin,
    isOnRoster: !!mine,
    isComing: !!mine && !out,
    isOut: !!mine && out,
  }
}

export interface ThreadState {
  /** false when the private-thread columns/table do not exist yet (legacy shared history). */
  private: boolean
  clearedAt: string | null
  lastSeenAt: string | null
}

export async function loadThreadState(client: SupabaseClient, tripId: string, userId: string): Promise<{ clearedAt: string | null; lastSeenAt: string | null }> {
  const { data, error } = await client.from('trip_chat_threads').select('cleared_at, last_seen_at').eq('trip_id', tripId).eq('user_id', userId).maybeSingle()
  if (error || !data) return { clearedAt: null, lastSeenAt: null }
  return { clearedAt: (data as { cleared_at: string | null }).cleared_at ?? null, lastSeenAt: (data as { last_seen_at: string | null }).last_seen_at ?? null }
}

interface HistoryRow { role: string; content: string; user_id?: string | null; turn_id?: string | null }

/**
 * The asker's own last turns, oldest first, as plain text. Falls back to the
 * legacy shared history (exactly the old behaviour) when the private-thread
 * columns are not there yet.
 */
export async function loadHistory(
  client: SupabaseClient, tripId: string, userId: string, clearedAt: string | null, nameById: Map<string, string>, currentTurnId: string | null = null,
): Promise<{ messages: AnthropicMessage[]; private: boolean; lastTurnId: string | null }> {
  let q = client.from('trip_chat_messages').select('role, content, user_id, turn_id', { count: 'exact' }).eq('trip_id', tripId).eq('thread_user_id', userId)
  if (clearedAt) q = q.gt('created_at', clearedAt)
  const res = await q.order('created_at', { ascending: false }).limit(HISTORY_MAX_ROWS)
  if (res.error) {
    if (!isMissingSchemaError(res.error)) throw new Error('Could not load the chat')
    const legacy = await client.from('trip_chat_messages').select('role, content, user_id').eq('trip_id', tripId).order('created_at', { ascending: false }).limit(30)
    const rows = ((legacy.data ?? []) as HistoryRow[]).reverse()
    return {
      messages: trimLeadingAssistant(rows.map((m) => m.role === 'assistant'
        ? { role: 'assistant' as const, content: m.content }
        : { role: 'user' as const, content: `[${nameById.get(m.user_id ?? '') ?? 'Someone'}]: ${m.content}` })),
      private: false,
      lastTurnId: null,
    }
  }
  // A retry of the current turn finds its own stored user row: it is re-added as the live message, so skip it here.
  const fetched = ((res.data ?? []) as HistoryRow[]).filter((r) => !(currentTurnId && r.turn_id === currentTurnId)).reverse()
  const total = typeof (res as { count?: number | null }).count === 'number' ? (res as { count: number }).count : fetched.length
  const skipped = Math.max(0, total - fetched.length) // rows older than the fetched ones
  let rows = fetched.slice(Math.max(0, historyWindowStart(total) - skipped))
  let chars = rows.reduce((a, r) => a + r.content.length, 0)
  while (rows.length > 2 && chars > HISTORY_MAX_CHARS) { chars -= rows[0].content.length; rows = rows.slice(1) }
  const lastTurnId = [...rows].reverse().find((r) => r.turn_id)?.turn_id ?? null
  return {
    messages: trimLeadingAssistant(rows.map((m) => ({ role: m.role === 'assistant' ? 'assistant' as const : 'user' as const, content: m.content }))),
    private: true,
    lastTurnId,
  }
}

function trimLeadingAssistant(m: AnthropicMessage[]): AnthropicMessage[] {
  let out = m
  while (out.length > 0 && out[0].role === 'assistant') out = out.slice(1)
  return out
}

/** One cache breakpoint on the last block of the replayed history. */
export function withHistoryBreakpoint(history: AnthropicMessage[]): AnthropicMessage[] {
  if (history.length === 0) return history
  const last = history[history.length - 1]
  const blocks: AnthropicContentBlock[] = typeof last.content === 'string'
    ? [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }]
    : last.content
  return [...history.slice(0, -1), { role: last.role, content: blocks }]
}

const KIND_WORDS: Record<string, string> = {
  add_todo: 'add a to-do', tick_todo: 'update a to-do', answer: 'record an answer', add_expense: 'add an expense',
  suggest_option: 'suggest an option', create_question: 'create a question', add_option: 'add an option',
}
const STATUS_WORDS: Record<string, string> = {
  done: 'was confirmed and done', failed: 'was confirmed but did not go through', dismissed: 'was dismissed', expired: 'expired unanswered',
  edited_elsewhere: 'was edited by the person in the normal screen', executing: 'was confirmed and is still going through',
}

/** Outcome line for the previous turn's actions, from the chat_actions rows (never from the client's say-so, never with trip text). */
export async function loadActionOutcomes(admin: SupabaseClient | null, tripId: string, userId: string, previousTurnId: string | null): Promise<string | null> {
  if (!admin || !previousTurnId) return null
  try {
    const { data, error } = await admin.from('chat_actions').select('kind, status').eq('trip_id', tripId).eq('user_id', userId).eq('turn_id', previousTurnId).order('created_at')
    if (error || !data || data.length === 0) return null
    const parts = (data as Array<{ kind: string; status: string }>).map((a) =>
      `the "${KIND_WORDS[a.kind] ?? 'change'}" card you proposed ${a.status === 'proposed' ? 'is still waiting for a tap' : (STATUS_WORDS[a.status] ?? a.status)}`)
    return `Since your last message: ${parts.join('; ')}.`
  } catch {
    return null
  }
}

export function capabilitiesText(viewer: ChatViewer, actionsEnabled: boolean, frozen: boolean): string {
  if (viewer.isOut) return 'This person is NOT going on the trip (declined, cancelled or removed): answer only money questions (what they owe, balances, expenses). Say so politely for anything else. Do not propose anything except an expense.'
  const lines: string[] = []
  if (!actionsEnabled) {
    lines.push('Proposing changes is switched OFF for this trip. If asked, say you can look things up but cannot make changes from chat yet, and offer open_screen links.')
  } else {
    const can = ['add a to-do (for themselves, someone, everyone or anyone)', 'tick/untick/claim their own to-do', "record their own answer to an open question", frozen ? null : 'add an expense', viewer.canManageTrip ? 'create a question with options, add an option to a question, add an idea to the Ideas list' : 'suggest an option or an idea'].filter(Boolean)
    lines.push(`They may ask you to: ${can.join('; ')}.`)
    if (frozen) lines.push('Balances are FROZEN: expenses cannot be added. Say so and offer open_screen settle.')
  }
  lines.push(viewer.canManageTrip ? 'Role: organiser (may see everyone\'s answers and who is still to answer).' : 'Role: participant (cannot see hidden answers or the waiting-on list; cannot create questions or options).')
  return lines.join(' ')
}

export interface DigestInput {
  ctx: ToolCtx
  page: string | null
  outcomes: string | null
  frozen: boolean
}

/**
 * Last line of the [Context] block. Live and in the eval a short imperative message ("Freeze this trip") was answered
 * with "I only see the context, what would you like to do?" and a recital of the person's to-dos: the model took the
 * context block for the whole turn. Saying plainly where the context ends and that the next block is the request fixes it.
 */
export const CONTEXT_FOOTER = '[End of context. The person\'s own message follows in the next block: it is the request to answer, however short it is.]'

/** The [Context] text block of the current user turn. Never throws: each part degrades to nothing. */
export async function buildContextBlock(i: DigestInput): Promise<string> {
  const { ctx } = i
  const [todos, money, toAnswer] = await Promise.all([
    computeMyTodoDigest(ctx).catch(() => null),
    computeMyMoneyLine(ctx).catch(() => null),
    questionsNeedingMyAnswer(ctx).catch(() => null),
  ])
  const lines = [
    '[Context]',
    `Today: ${ctx.today} (${ctx.tzLabel ?? 'UTC'}). Talking to: ${ctx.me.name.replace(/[<>\n]/g, ' ')}.`,
    i.page ? `They are looking at the ${i.page} page.` : null,
    capabilitiesText(ctx.me, ctx.actionsEnabled, i.frozen),
  ]
  if (todos) {
    lines.push(todos.count === 0 ? 'Your to-dos: none open.' : `Your to-dos: ${todos.count} open${todos.items.length ? ':' : '.'}`)
    for (const t of todos.items) lines.push(`- ${t.title} (${t.source}, id ${t.entityId ?? t.id})`)
    if (todos.moreCount > 0) lines.push(`- ...and ${todos.moreCount} more (call get_my_todos)`)
  }
  if (toAnswer != null) lines.push(`Questions waiting for your answer: ${toAnswer}.`)
  if (money) lines.push(`Money: ${money}`)
  if (i.outcomes) lines.push(i.outcomes)
  lines.push(CONTEXT_FOOTER)
  return lines.filter(Boolean).join('\n')
}

export { tripData }
