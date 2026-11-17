/**
 * Server-side builder of the to-dos engine's TripSnapshot (trip-chat reads).
 *
 * Mirrors src/lib/queries/useTodos.ts (`useTripSnapshot` + `assembleSnapshot`)
 * and the queries it reads (useTrip, useParticipants, useAllParticipants,
 * useSections, useVotes, useQuestionPasses, useActions, useChecklists,
 * useExpenses, useClaimResponses, useSettlements, useTimeline, useBookings), so
 * `computeTodos(snapshot, userId)` here equals the Today page.
 *
 * NOT a byte mirror (the drift check does not cover this file): it is a new
 * Deno-side file next to the mirrored engine. Differences from the client, all
 * deliberate:
 *  - Reads are FLAT (one select per table, joined in code) instead of PostgREST
 *    embeds, so any fake or real client answers them the same way.
 *  - Users are fetched with `full_name, first_name` only: no email ever enters
 *    a snapshot (the engine falls back to "someone").
 *  - All-or-nothing like the client: a failed REQUIRED read returns null.
 *    `question_passes`, `expense_claim_responses` and `trip_actions.who_mode`
 *    fail soft (missing table / column = the engine's old rules).
 *
 * Everything runs with the caller's client (their JWT), so RLS applies.
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import type {
  SnapshotAction,
  SnapshotBooking,
  SnapshotChecklistItem,
  SnapshotParticipant,
  SnapshotSettlement,
  SnapshotTravelEvent,
  SnapshotTrip,
  SnapshotVote,
  TripSnapshot,
} from './types.ts'
import type { AnswerPass } from '../answers/answers.ts'
import { isTripFinished } from '../answers/answers.ts'
import type { ExpenseWithDetails, Settlement, SettlementCarryover } from '../money/balanceTypes.ts'
import { computeBalances, withMoneyParticipants } from '../money/balances.ts'
import { fromMinorUnits } from '../money/minorUnits.ts'

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>

/** Postgres / PostgREST codes for "that table or column is not there (yet)". */
const MISSING_SCHEMA_CODES = new Set(['42P01', '42703', 'PGRST205', 'PGRST204', 'PGRST200'])

export function isMissingSchemaError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false
  if (error.code && MISSING_SCHEMA_CODES.has(error.code)) return true
  const m = (error.message ?? '').toLowerCase()
  return m.includes('does not exist') || m.includes('schema cache')
}

export interface SectionRow extends Row {
  id: string
  title: string
  status: string
  vote_deadline: string | null
  voting_method: string | null
  metadata: Row | null
  section_type?: string | null
  order_index?: number | null
  hide_votes_until_close?: boolean | null
  options: Array<Row & { id: string; status: string; selections: Array<Row & { user_id: string }> }>
}

/** Everything the snapshot is built from, as rows. Tools reuse it (one fetch per turn). */
export interface SnapshotData {
  trip: Row & SnapshotTrip
  participants: Array<Row & SnapshotParticipant>
  allParticipants: Array<Row & SnapshotParticipant>
  sections: SectionRow[]
  votes: Array<Row & SnapshotVote>
  passes: { rows: AnswerPass[]; available: boolean }
  actions: Array<Row & SnapshotAction>
  checklists: Array<Row & SnapshotChecklistItem>
  expenses: ExpenseWithDetails[]
  claimResponses: { rows: Array<{ expense_id: string; user_id: string; response: string }>; available: boolean }
  settlements: Settlement[]
  carryovers: SettlementCarryover[]
  timeline: Array<Row & SnapshotTravelEvent>
  bookings: Array<Row & SnapshotBooking>
}

type Res = { data: unknown; error: { code?: string | null; message?: string | null } | null }

function must<T>(res: Res, label: string): T[] {
  if (res.error) throw new Error(`${label}: ${res.error.code ?? 'error'}`)
  return (res.data ?? []) as T[]
}

function groupBy<T extends Row>(rows: T[], key: string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const r of rows) {
    const k = r[key] as string
    const list = out.get(k)
    if (list) list.push(r)
    else out.set(k, [r])
  }
  return out
}

/** The same ordering `useSections` applies: in progress first, then not started, then completed; by order_index inside. */
function sortSections<T extends { status: string; order_index?: number | null }>(sections: T[]): T[] {
  const statusOrder: Record<string, number> = { in_progress: 1, not_started: 2, completed: 3 }
  return [...sections].sort((a, b) => {
    const oa = statusOrder[a.status] || 4
    const ob = statusOrder[b.status] || 4
    if (oa === ob) return (a.order_index || 0) - (b.order_index || 0)
    return oa - ob
  })
}

const byOrderIndex = (a: Row, b: Row) => (a.order_index ?? 0) - (b.order_index ?? 0)

/** Resolve to the rows, or [] with `ok:false` when the table / column is not there. Other failures throw (all-or-nothing). */
async function soft(p: PromiseLike<Res>, label: string): Promise<{ rows: Row[]; ok: boolean }> {
  const res = await p
  if (res.error) {
    if (isMissingSchemaError(res.error)) return { rows: [], ok: false }
    // The client treats ANY failure of these two reads as "not available" too (retry:false, available = isSuccess).
    console.warn(`trip-chat snapshot: ${label} unavailable (${res.error.code ?? 'error'})`)
    return { rows: [], ok: false }
  }
  return { rows: (res.data ?? []) as Row[], ok: true }
}

/**
 * Fetch every input. Returns null when any REQUIRED read fails or the trip is
 * not visible to the caller (never a partial snapshot).
 */
export async function fetchSnapshotData(client: SupabaseClient, tripId: string): Promise<SnapshotData | null> {
  try {
    const [tripRes, partRes, sectionRes, actionRes, completionRes, checklistRes, expenseRes, settlementRes, carryoverRes, timelineRes, bookingRes] = await Promise.all([
      client.from('trips').select('*').eq('id', tripId).maybeSingle(),
      client.from('trip_participants').select('*').eq('trip_id', tripId),
      client.from('planning_sections').select('*').eq('trip_id', tripId).order('order_index', { ascending: true }),
      client.from('trip_actions').select('*').eq('trip_id', tripId).order('created_at', { ascending: true }),
      client.from('trip_action_completions').select('action_id, user_id, completed_at').eq('trip_id', tripId),
      client.from('trip_checklists').select('*').eq('trip_id', tripId).order('created_at', { ascending: true }),
      client.from('expenses').select('*').eq('trip_id', tripId).order('created_at', { ascending: false }),
      client.from('settlements').select('*').eq('trip_id', tripId),
      client.from('settlement_carryovers').select('*').eq('trip_id', tripId),
      client.from('trip_timeline_events').select('*').eq('trip_id', tripId).order('event_date').order('start_time').order('sort_order'),
      client.from('bookings').select('*').eq('trip_id', tripId).order('created_at', { ascending: false }),
    ])

    if (tripRes.error || !tripRes.data) return null
    const trip = tripRes.data as Row & SnapshotTrip
    const allParticipantRows = must<Row>(partRes, 'trip_participants')
    const sectionRows = must<Row>(sectionRes, 'planning_sections')
    const actionRows = must<Row>(actionRes, 'trip_actions')
    const completionRows = must<Row>(completionRes, 'trip_action_completions')
    const checklistRows = must<Row>(checklistRes, 'trip_checklists')
    const expenseRows = must<Row>(expenseRes, 'expenses')
    const settlementRows = must<Settlement>(settlementRes, 'settlements')
    const carryoverRows = must<SettlementCarryover>(carryoverRes, 'settlement_carryovers')
    const timelineRows = must<Row>(timelineRes, 'trip_timeline_events')
    const bookingRows = must<Row>(bookingRes, 'bookings')

    const sectionIds = sectionRows.map((s) => s.id as string)
    const itemizedIds = expenseRows.filter((e) => e.ai_parsed && e.status).map((e) => e.id as string)
    const expenseIds = expenseRows.map((e) => e.id as string)
    const optionLinkedIds = [...new Set(expenseRows.filter((e) => e.option_id).map((e) => e.option_id as string))]
    const userIds = [...new Set(allParticipantRows.map((p) => p.user_id as string))]

    // Options -> selections -> votes depend on the section ids.
    const optionRes = sectionIds.length > 0 ? await client.from('options').select('*').in('section_id', sectionIds).order('order_index', { ascending: true }) : { data: [], error: null }
    const optionRows = must<Row>(optionRes as Res, 'options')
    const optionIds = optionRows.map((o) => o.id as string)

    const empty = Promise.resolve({ data: [], error: null } as Res)
    const [selectionRes, voteRes, userRes, splitRes, lineRes, claimRes, linkRes, linkedSelRes, passes, responses] = await Promise.all([
      optionIds.length > 0 ? client.from('selections').select('*').in('option_id', optionIds) : empty,
      optionIds.length > 0 ? client.from('option_votes').select('*').in('option_id', optionIds) : empty,
      userIds.length > 0 ? client.from('users').select('id, full_name, first_name').in('id', userIds) : empty,
      expenseIds.length > 0 ? client.from('expense_splits').select('*').in('expense_id', expenseIds) : empty,
      itemizedIds.length > 0 ? client.from('expense_line_items').select('*').in('expense_id', itemizedIds).order('line_number') : empty,
      itemizedIds.length > 0 ? client.from('expense_item_claims').select('*').in('expense_id', itemizedIds) : empty,
      itemizedIds.length > 0 ? client.from('expense_allocation_links').select('*').in('expense_id', itemizedIds) : empty,
      optionLinkedIds.length > 0 ? client.from('selections').select('option_id, user_id').in('option_id', optionLinkedIds) : empty,
      soft(client.from('question_passes').select('section_id, user_id, kind, created_at').in('section_id', sectionIds), 'question_passes'),
      soft(client.from('expense_claim_responses').select('expense_id, user_id, response').in('expense_id', expenseIds), 'expense_claim_responses'),
    ])

    const selections = must<Row>(selectionRes as Res, 'selections')
    const votes = must<Row>(voteRes as Res, 'option_votes') as Array<Row & SnapshotVote>
    const users = new Map(must<Row>(userRes as Res, 'users').map((u) => [u.id as string, { full_name: u.full_name ?? null, first_name: u.first_name ?? null }]))
    const splits = groupBy(must<Row>(splitRes as Res, 'expense_splits'), 'expense_id')
    const lines = groupBy(must<Row>(lineRes as Res, 'expense_line_items'), 'expense_id')
    const claims = groupBy(must<Row>(claimRes as Res, 'expense_item_claims'), 'expense_id')
    const links = new Map(must<Row>(linkRes as Res, 'expense_allocation_links').map((l) => [l.expense_id as string, l]))
    const optionSelections: Record<string, string[]> = {}
    for (const sel of must<Row>(linkedSelRes as Res, 'selections')) (optionSelections[sel.option_id] ??= []).push(sel.user_id)

    // Sections with nested options and selections (the shape useSections returns).
    const selectionsByOption = groupBy(selections, 'option_id')
    const optionsBySection = groupBy(optionRows, 'section_id')
    const sections = sortSections(
      sectionRows.map(
        (s): SectionRow =>
          ({
            ...s,
            options: [...(optionsBySection.get(s.id) ?? [])].sort(byOrderIndex).map((o) => ({ ...o, selections: selectionsByOption.get(o.id) ?? [] })),
          }) as SectionRow
      )
    )

    const withUser = (p: Row) => ({ ...p, user: users.get(p.user_id) ?? null })
    const allParticipants = allParticipantRows.map(withUser) as SnapshotData['allParticipants']
    const participants = allParticipants.filter((p) => p.active === true)

    const completionsByAction = groupBy(completionRows, 'action_id')
    const actions = actionRows.map((a) => ({ ...a, trip_action_completions: completionsByAction.get(a.id) ?? [] })) as unknown as SnapshotData['actions']

    const expenses = expenseRows.map((e) => ({
      ...e,
      splits: splits.get(e.id) ?? [],
      line_items: lines.get(e.id) ?? [],
      claims: claims.get(e.id) ?? [],
      allocation_link: links.get(e.id) ?? null,
      expected_participants: e.option_id ? optionSelections[e.option_id] ?? [] : [],
    })) as unknown as ExpenseWithDetails[]

    return {
      trip,
      participants,
      allParticipants,
      sections,
      votes,
      passes: { rows: passes.rows as AnswerPass[], available: passes.ok },
      actions,
      checklists: checklistRows as SnapshotData['checklists'],
      expenses,
      claimResponses: { rows: responses.rows as SnapshotData['claimResponses']['rows'], available: responses.ok },
      settlements: settlementRows,
      carryovers: carryoverRows,
      timeline: timelineRows as SnapshotData['timeline'],
      bookings: bookingRows as SnapshotData['bookings'],
    }
  } catch (e) {
    console.warn('trip-chat snapshot: build failed', e instanceof Error ? e.message : 'error')
    return null
  }
}

/** Put each itemised receipt's responses on its snapshot expense (client: withClaimResponses). Not read = untouched. */
export function withClaimResponses(expenses: ExpenseWithDetails[], rows: SnapshotData['claimResponses']['rows'], available: boolean): ExpenseWithDetails[] {
  if (!available) return expenses
  const byExpense = new Map<string, Array<{ user_id: string; response: string }>>()
  for (const r of rows) {
    const list = byExpense.get(r.expense_id) ?? []
    list.push({ user_id: r.user_id, response: r.response })
    byExpense.set(r.expense_id, list)
  }
  return expenses.map((e) => ({ ...e, responses: byExpense.get(e.id) ?? [] }))
}

/** Net balances in base-currency major units (negative = owes), only on Finished trips, like the client. */
export function snapshotBalances(data: SnapshotData, now: Date): Record<string, number> | undefined {
  if (!isTripFinished(data.trip, now)) return undefined
  const base = data.trip.base_currency
  const ids = withMoneyParticipants(
    data.participants.map((p) => p.user_id),
    data.expenses,
    data.settlements,
    base,
    data.carryovers
  )
  const { balances } = computeBalances(data.expenses, data.settlements, ids, base, data.carryovers)
  return Object.fromEntries(balances.map((b) => [b.userId, fromMinorUnits(b.netBalanceMinor, base)]))
}

/** Assemble the engine's snapshot from the fetched rows (client: assembleSnapshot + useTripSnapshot). */
export function assembleTripSnapshot(data: SnapshotData, now: Date = new Date()): TripSnapshot {
  const expenses = withClaimResponses(data.expenses, data.claimResponses.rows, data.claimResponses.available)
  return {
    trip: data.trip,
    participants: data.participants,
    allParticipants: data.allParticipants,
    sections: data.sections as unknown as TripSnapshot['sections'],
    votes: data.votes,
    passes: data.passes.rows,
    passesAvailable: data.passes.available,
    actions: data.actions,
    checklists: data.checklists,
    expenses: expenses as unknown as TripSnapshot['expenses'],
    settlements: data.settlements as unknown as SnapshotSettlement[],
    balances: snapshotBalances(data, now),
    travelEvents: data.timeline,
    bookings: data.bookings,
  }
}

/** One call: fetch + assemble. null = could not read everything (never a partial snapshot). */
export async function buildTripSnapshot(client: SupabaseClient, tripId: string, now: Date = new Date()): Promise<TripSnapshot | null> {
  const data = await fetchSnapshotData(client, tripId)
  return data ? assembleTripSnapshot(data, now) : null
}
