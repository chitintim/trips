/**
 * Shared plumbing for the propose tools: text cleaning, dates, the gate every
 * propose tool passes first, live reads, content-origin labels and the one
 * store-and-emit step.
 */
import { z } from 'npm:zod@3'
import { effectiveTripStage } from '../../../_shared/todos/deps/tripStage.ts'
import { type ChatActionEnvelope, type Json, MAX_ACTIONS_PER_TURN, memoize, refuse, type ToolCtx, type ToolResult } from '../types.ts'
import type { BasisCommon, ContentOrigin, PersonRef, StoredKind } from './cards.ts'
import { findExistingAction, insertChatAction } from './store.ts'

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

// C0/C1 controls except tab/newline/CR, zero-width and bidi override characters, BOM.

const HIDDEN_CHARS = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]',
  'g',
)

/** One line of content: control characters gone, whitespace collapsed, trimmed. */
export function cleanLine(s: string): string {
  return s.normalize('NFC').replace(HIDDEN_CHARS, '').replace(/\s+/g, ' ').trim()
}

/** Multi-line content (notes): control characters gone, line breaks kept (max one blank line), trimmed. */
export function cleanNote(s: string): string {
  return s
    .normalize('NFC')
    .replace(HIDDEN_CHARS, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Zod: a cleaned one-line string with the real limit (checked AFTER cleaning). */
export const line = (max: number) =>
  z.string().transform(cleanLine).pipe(z.string().min(1, 'must not be empty').max(max, `must be at most ${max} characters`))

/** Zod: optional cleaned note. null or empty-after-cleaning -> null. */
export const note = (max: number) =>
  z
    .string()
    .nullable()
    .transform((v) => (v == null ? null : cleanNote(v) || null))
    .pipe(z.string().max(max, `must be at most ${max} characters`).nullable())

export const uuid = z.string().uuid()

export function formatZodError(err: z.ZodError): string {
  const parts = err.issues.slice(0, 4).map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
  return `Invalid input (${parts.join('; ')}). Fix it and try again.`
}

/** Parse raw model input; a failure becomes a plain refusal the model can act on. */
export function parseInput<S extends z.ZodTypeAny>(schema: S, raw: unknown): { ok: true; data: z.infer<S> } | { ok: false; result: ToolResult } {
  const r = schema.safeParse(raw)
  if (r.success) return { ok: true, data: r.data }
  return { ok: false, result: refuse(formatZodError(r.error)) }
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`
}

// ---------------------------------------------------------------------------
// Dates (UTC calendar days; the app's trip dates are naive)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

export function addDays(s: string, days: number): string {
  return new Date(new Date(`${s}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10)
}

export function daysBetween(from: string, to: string): number {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / DAY_MS)
}

/** "Fri 21 Nov" (year added when it is not the current year). */
export function dayLabel(s: string, today: string): string {
  const d = new Date(`${s}T00:00:00Z`)
  const base = `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
  return s.slice(0, 4) === today.slice(0, 4) ? base : `${base} ${s.slice(0, 4)}`
}

export function dateTimeLabel(iso: string, today: string): string {
  const d = new Date(iso)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${dayLabel(d.toISOString().slice(0, 10), today)} ${hh}:${mm} UTC`
}

// ---------------------------------------------------------------------------
// Plain messages
// ---------------------------------------------------------------------------

export const NOT_ON_MESSAGE = 'Actions are not switched on for this trip yet. Tell the person you cannot make changes from chat yet, and describe what they could do in the app instead.'
export const OUT_MESSAGE = "You're not going on this trip, so I can only help with money."
export const FROZEN_MESSAGE = 'Balances are frozen on this trip, so expenses cannot be added. Ask an organiser to unfreeze.'
export const FINISHED_MESSAGE = 'This trip is finished, so changes like this are closed.'

/** Nothing is written; not an error for the model. */
export function notSwitchedOn(): ToolResult {
  return { content: { ok: false, not_enabled: true, message: NOT_ON_MESSAGE }, is_error: false }
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export type Scope = 'money' | 'group'

/** Steps (0) and the part of (3) every propose tool shares. Returns a result to hand back, or null to continue. */
export function gate(ctx: ToolCtx, scope: Scope): ToolResult | null {
  if (!ctx.actionsEnabled || !ctx.admin) return notSwitchedOn()
  if (!ctx.me.isOnRoster) return refuse("You're not on this trip's roster, so I can't suggest changes for you.")
  if (ctx.me.isOut && scope === 'group') return refuse(OUT_MESSAGE)
  if (ctx.proposedThisTurn.count >= MAX_ACTIONS_PER_TURN) {
    return refuse(`You can suggest at most ${MAX_ACTIONS_PER_TURN} changes in one message. Ask the person to confirm these first.`)
  }
  return null
}

// ---------------------------------------------------------------------------
// Live reads
// ---------------------------------------------------------------------------

export interface TripState {
  frozen: boolean
  finished: boolean
  confirmationEnabled: boolean
}

/** Fresh frozen/finished state (one read per turn); falls back to the turn's snapshot of the trip. */
export function tripState(ctx: ToolCtx): Promise<TripState> {
  return memoize(ctx, 'propose:tripState', async () => {
    let snapshot: Json | null = ctx.trip.settlement_snapshot
    let status = ctx.trip.status
    let confirmation = ctx.trip.confirmation_enabled
    try {
      const { data, error } = await ctx.client.from('trips').select('settlement_snapshot,status,confirmation_enabled').eq('id', ctx.tripId).maybeSingle()
      if (!error && data) {
        const row = data as { settlement_snapshot?: Json | null; status?: string; confirmation_enabled?: boolean | null }
        snapshot = row.settlement_snapshot ?? null
        status = row.status ?? status
        confirmation = row.confirmation_enabled ?? confirmation
      }
    } catch { /* keep the snapshot */ }
    const stage = effectiveTripStage({ status: status as never, start_date: ctx.trip.start_date, end_date: ctx.trip.end_date }, ctx.today)
    return { frozen: snapshot != null, finished: stage === 'trip_completed', confirmationEnabled: confirmation === true }
  })
}

export function baseBasis(ctx: ToolCtx, s: TripState): BasisCommon {
  return { captured_at: ctx.now.toISOString(), trip_frozen: s.frozen, trip_finished: s.finished, i_am_out: ctx.me.isOut }
}

export interface SectionRow {
  id: string
  trip_id: string
  title: string
  status: string
  metadata: Json | null
  voting_method: string | null
  vote_deadline: string | null
  updated_at: string | null
  section_type?: string | null
}

export interface OptionRow {
  id: string
  section_id: string
  title: string
  status: string
  locked: boolean | null
  metadata: Json | null
}

/** A question on THIS trip, or null. */
export async function loadSection(ctx: ToolCtx, id: string): Promise<SectionRow | null> {
  const { data, error } = await ctx.client
    .from('planning_sections')
    .select('id,trip_id,title,status,metadata,voting_method,vote_deadline,updated_at,section_type')
    .eq('id', id)
    .eq('trip_id', ctx.tripId)
    .maybeSingle()
  if (error || !data) return null
  return data as SectionRow
}

export async function loadOptions(ctx: ToolCtx, sectionId: string): Promise<OptionRow[]> {
  const { data, error } = await ctx.client
    .from('options')
    .select('id,section_id,title,status,locked,metadata')
    .eq('section_id', sectionId)
  if (error || !data) return []
  return data as OptionRow[]
}

export const NOT_FOUND_QUESTION = 'That question was not found on this trip. Use an id from the trip context.'

export function metaObject(m: Json | null | undefined): Record<string, Json> {
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, Json>) : {}
}

export function isOwnChoiceSection(s: { metadata: Json | null }): boolean {
  return metaObject(s.metadata).decision_shape === 'personal'
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export function personRef(ctx: ToolCtx, userId: string): PersonRef {
  return { user_id: userId, name: ctx.roster.find((p) => p.userId === userId)?.name ?? 'Someone' }
}

export function onRoster(ctx: ToolCtx, userId: string) {
  return ctx.roster.find((p) => p.userId === userId) ?? null
}

// ---------------------------------------------------------------------------
// Content origin (best effort): text copied from someone else's trip data
// ---------------------------------------------------------------------------

export async function findOrigin(ctx: ToolCtx, text: string, sources: ReadonlyArray<ContentOrigin['source']>): Promise<ContentOrigin | null> {
  const label = (userId: string | null | undefined, source: ContentOrigin['source']): ContentOrigin | null => {
    if (!userId || userId === ctx.userId) return null
    const p = onRoster(ctx, userId)
    return p ? { author_id: userId, author_name: p.name, source } : null
  }
  try {
    if (sources.includes('todo')) {
      const { data } = await ctx.client.from('trip_actions').select('created_by').eq('trip_id', ctx.tripId).eq('title', text)
      for (const r of (data ?? []) as Array<{ created_by: string | null }>) {
        const o = label(r.created_by, 'todo')
        if (o) return o
      }
    }
    if (sources.includes('option')) {
      const { data: secs } = await ctx.client.from('planning_sections').select('id').eq('trip_id', ctx.tripId)
      const ids = ((secs ?? []) as Array<{ id: string }>).map((s) => s.id)
      if (ids.length > 0) {
        const { data } = await ctx.client.from('options').select('metadata').in('section_id', ids).eq('title', text)
        for (const r of (data ?? []) as Array<{ metadata: Json | null }>) {
          const by = metaObject(r.metadata).suggested_by
          const o = label(typeof by === 'string' ? by : null, 'option')
          if (o) return o
        }
      }
    }
    if (sources.includes('expense')) {
      const { data } = await ctx.client.from('expenses').select('paid_by').eq('trip_id', ctx.tripId).eq('description', text)
      for (const r of (data ?? []) as Array<{ paid_by: string | null }>) {
        const o = label(r.paid_by, 'expense')
        if (o) return o
      }
    }
  } catch { /* best effort */ }
  return null
}

export async function originsFor(
  ctx: ToolCtx,
  fields: Array<{ field: string; text: string; sources: ReadonlyArray<ContentOrigin['source']> }>,
): Promise<Record<string, ContentOrigin>> {
  const out: Record<string, ContentOrigin> = {}
  for (const f of fields) {
    const o = await findOrigin(ctx, f.text, f.sources)
    if (o) out[f.field] = o
  }
  return out
}

// ---------------------------------------------------------------------------
// Store + emit (steps 6-8)
// ---------------------------------------------------------------------------

export interface Proposal {
  kind: StoredKind
  params: unknown
  preview: unknown
  basis: unknown
  requires: 'tap' | 'review'
}

/**
 * Insert ONE chat_actions row (service role), emit the envelope, and hand the model back only
 * {ok, action_id, kind, requires}. Dedupes within the turn; enforces the 5-per-turn cap with a
 * reservation taken before the insert so parallel tool calls cannot overshoot.
 */
export function storeProposal(ctx: ToolCtx, p: Proposal): Promise<ToolResult> {
  const key = stableStringify(p.params)
  return memoize(ctx, `propose:${p.kind}:${key}`, async () => {
    const admin = ctx.admin
    if (!admin) return notSwitchedOn()
    const envelope = (row: { id: string; status: string; expires_at: string | null }, src: Proposal): ChatActionEnvelope => ({
      id: row.id,
      kind: src.kind,
      params: src.params as Json,
      preview: src.preview as Json,
      basis: src.basis as Json,
      requires: src.requires,
      status: row.status,
      expires_at: row.expires_at,
      turn_id: ctx.turnId,
    })
    // One card per row: an action event is sent once per id, however many times the model proposes it.
    const emitOnce = (e: ChatActionEnvelope) => {
      const seen = (ctx.memo.get('emitted-action-ids') as unknown as Set<string> | undefined) ?? new Set<string>()
      ctx.memo.set('emitted-action-ids', seen as unknown as Promise<unknown>)
      if (seen.has(e.id)) return
      seen.add(e.id)
      ctx.emitAction(e)
    }
    const ok = (id: string, already = false): ToolResult => ({
      content: {
        ok: true,
        action_id: id,
        kind: p.kind,
        requires: p.requires,
        ...(already ? { already_proposed: true } : {}),
        note: already
          ? 'This exact card already exists for the person (same suggestion made twice). Do not propose it again. Say one short sentence.'
          : 'The person now sees a card to confirm. Nothing has changed yet. Say one short sentence; do not repeat the details.',
      },
    })

    const existing = await findExistingAction(admin, { trip_id: ctx.tripId, user_id: ctx.userId, turn_id: ctx.turnId, kind: p.kind }, key, stableStringify)
    if ('missing' in existing) return notSwitchedOn()
    if (existing.found) {
      emitOnce(envelope(existing.found, { ...p, params: existing.found.params, preview: existing.found.preview, basis: existing.found.basis, requires: existing.found.requires }))
      return ok(existing.found.id, true)
    }

    if (ctx.proposedThisTurn.count >= MAX_ACTIONS_PER_TURN) {
      return refuse(`You can suggest at most ${MAX_ACTIONS_PER_TURN} changes in one message. Ask the person to confirm these first.`)
    }
    ctx.proposedThisTurn.count += 1

    const res = await insertChatAction(admin, {
      trip_id: ctx.tripId,
      user_id: ctx.userId,
      turn_id: ctx.turnId,
      kind: p.kind,
      params: p.params as Json,
      preview: p.preview as Json,
      basis: p.basis as Json,
      requires: p.requires,
      status: 'proposed',
    })
    if (!res.ok) {
      ctx.proposedThisTurn.count -= 1
      if (!res.missing && res.duplicate) {
        // Lost a race with an identical parallel proposal: reuse its row.
        const again = await findExistingAction(admin, { trip_id: ctx.tripId, user_id: ctx.userId, turn_id: ctx.turnId, kind: p.kind }, key, stableStringify)
        if ('found' in again && again.found) {
          emitOnce(envelope(again.found, { ...p, params: again.found.params, preview: again.found.preview, basis: again.found.basis, requires: again.found.requires }))
          return ok(again.found.id, true)
        }
        return { content: { ok: false, error: 'That suggestion already exists. Do not propose it again.' }, is_error: true }
      }
      if (res.missing) return notSwitchedOn()
      return { content: { ok: false, error: 'Could not save that suggestion. Please try again in a moment.' }, is_error: true }
    }
    emitOnce(envelope(res.row, p))
    return ok(res.row.id)
  })
}
