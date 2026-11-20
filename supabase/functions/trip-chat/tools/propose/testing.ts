/**
 * Test helpers: a tiny in-memory PostgREST-like fake (filters, insert/update/delete recorded) and a ToolCtx
 * builder. No network. The fake records every write with WHICH client made it, so tests can assert that
 * the user's client never writes and the service role writes only chat_actions.
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import type { ChatActionEnvelope, RosterPerson, ToolCtx } from '../types.ts'

export type Row = Record<string, unknown>

export interface WriteRecord {
  by: 'user' | 'admin'
  op: 'insert' | 'update' | 'delete' | 'upsert' | 'rpc'
  table: string
  row?: Row
}

export interface FakeDb {
  tables: Record<string, Row[]>
  writes: WriteRecord[]
  /** table -> error returned for any access ('42P01' = missing table). */
  tableErrors: Record<string, { code: string; message: string }>
  /** table -> error returned only for inserts. */
  insertErrors: Record<string, { code: string; message: string }>
  reads: string[]
}

export function newDb(tables: Record<string, Row[]> = {}): FakeDb {
  return { tables: structuredClone(tables), writes: [], tableErrors: {}, insertErrors: {}, reads: [] }
}

class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Array<(r: Row) => boolean> = []
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select'
  private payload: Row | Row[] | null = null
  private mode: 'one' | 'maybe' | null = null
  private limitN: number | null = null

  constructor(private db: FakeDb, private table: string, private by: 'user' | 'admin') {}

  select(_cols?: string, _opts?: unknown) {
    return this
  }
  insert(row: Row | Row[]) {
    this.op = 'insert'
    this.payload = row
    return this
  }
  update(row: Row) {
    this.op = 'update'
    this.payload = row
    return this
  }
  delete() {
    this.op = 'delete'
    return this
  }
  upsert(row: Row | Row[]) {
    this.op = 'insert'
    this.payload = row
    return this
  }
  eq(col: string, val: unknown) {
    this.filters.push((r) => r[col] === val)
    return this
  }
  gt(col: string, val: unknown) {
    this.filters.push((r) => String(r[col]) > String(val))
    return this
  }
  gte(col: string, val: unknown) {
    this.filters.push((r) => String(r[col]) >= String(val))
    return this
  }
  neq(col: string, val: unknown) {
    this.filters.push((r) => r[col] !== val)
    return this
  }
  contains(col: string, vals: unknown[]) {
    this.filters.push((r) => Array.isArray(r[col]) && vals.every((v) => (r[col] as unknown[]).includes(v)))
    return this
  }
  in(col: string, vals: unknown[]) {
    this.filters.push((r) => vals.includes(r[col]))
    return this
  }
  is(col: string, val: unknown) {
    this.filters.push((r) => (val === null ? r[col] == null : r[col] === val))
    return this
  }
  order() {
    return this
  }
  limit(n: number) {
    this.limitN = n
    return this
  }
  maybeSingle() {
    this.mode = 'maybe'
    return this
  }
  single() {
    this.mode = 'one'
    return this
  }

  then<R1 = { data: unknown; error: unknown }, R2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.exec()).then(onfulfilled, onrejected)
  }

  private exec(): { data: unknown; error: unknown } {
    const err = this.db.tableErrors[this.table]
    if (err) return { data: null, error: err }
    const rows = (this.db.tables[this.table] ??= [])
    if (this.op === 'insert') {
      const ie = this.db.insertErrors[this.table]
      if (ie) return { data: null, error: ie }
      const list = Array.isArray(this.payload) ? this.payload : [this.payload as Row]
      const made = list.map((r) => ({
        id: crypto.randomUUID(),
        created_at: '2026-11-17T10:00:00.000Z',
        expires_at: '2026-11-18T10:00:00.000Z',
        ...r,
      }))
      for (const m of made) {
        rows.push(m)
        this.db.writes.push({ by: this.by, op: 'insert', table: this.table, row: m })
      }
      return this.shape(made)
    }
    const matched = rows.filter((r) => this.filters.every((f) => f(r)))
    if (this.op === 'update') {
      for (const m of matched) {
        Object.assign(m, this.payload)
        this.db.writes.push({ by: this.by, op: 'update', table: this.table, row: m })
      }
      return this.shape(matched)
    }
    if (this.op === 'delete') {
      for (const m of matched) {
        rows.splice(rows.indexOf(m), 1)
        this.db.writes.push({ by: this.by, op: 'delete', table: this.table, row: m })
      }
      return this.shape(matched)
    }
    this.db.reads.push(this.table)
    return this.shape(this.limitN != null ? matched.slice(0, this.limitN) : matched)
  }

  private shape(rows: Row[]): { data: unknown; error: unknown } {
    if (this.mode === 'maybe') return { data: rows[0] ?? null, error: null }
    if (this.mode === 'one') return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } }
    return { data: rows, error: null }
  }
}
export function fakeClient(db: FakeDb, by: 'user' | 'admin'): SupabaseClient {
  return {
    from: (table: string) => new Query(db, table, by),
    rpc: (name: string) => {
      db.writes.push({ by, op: 'rpc', table: name })
      return Promise.resolve({ data: null, error: null })
    },
  } as unknown as SupabaseClient
}

// ---------------------------------------------------------------------------
// Fixture trip
// ---------------------------------------------------------------------------

export const TRIP = '00000000-0000-4000-8000-0000000000a1'
export const OTHER_TRIP = '00000000-0000-4000-8000-0000000000a2'
export const ME = '10000000-0000-4000-8000-000000000001'
export const SAM = '10000000-0000-4000-8000-000000000002'
export const ANA = '10000000-0000-4000-8000-000000000003'
export const BEN = '10000000-0000-4000-8000-000000000004'
export const OUT = '10000000-0000-4000-8000-000000000005'
export const STRANGER = '10000000-0000-4000-8000-000000000099'
export const SEC_OPEN = '20000000-0000-4000-8000-000000000001'
export const SEC_DONE = '20000000-0000-4000-8000-000000000002'
export const SEC_RANK = '20000000-0000-4000-8000-000000000003'
export const SEC_OWN = '20000000-0000-4000-8000-000000000004'
export const SEC_OTHER_TRIP = '20000000-0000-4000-8000-000000000009'
export const OPT_A = '30000000-0000-4000-8000-000000000001'
export const OPT_B = '30000000-0000-4000-8000-000000000002'
export const OPT_C = '30000000-0000-4000-8000-000000000003'
export const OPT_DONE = '30000000-0000-4000-8000-000000000004'
export const OPT_R1 = '30000000-0000-4000-8000-000000000011'
export const OPT_R2 = '30000000-0000-4000-8000-000000000012'
export const OPT_R3 = '30000000-0000-4000-8000-000000000013'
export const OPT_OWN1 = '30000000-0000-4000-8000-000000000021'
export const OPT_OTHER_TRIP = '30000000-0000-4000-8000-000000000099'
export const TURN = '40000000-0000-4000-8000-000000000001'
export const TODO_MINE = '50000000-0000-4000-8000-000000000001'
export const TODO_SAMS = '50000000-0000-4000-8000-000000000002'
export const TODO_EVERYONE = '50000000-0000-4000-8000-000000000003'
export const TODO_ANYONE = '50000000-0000-4000-8000-000000000004'
export const TODO_OTHER_TRIP = '50000000-0000-4000-8000-000000000009'
export const BRING_FREE = '60000000-0000-4000-8000-000000000001'
export const EXPENSE_1 = '70000000-0000-4000-8000-000000000001'

export function roster(): RosterPerson[] {
  const p = (userId: string, name: string, role: string | null, active = true, confirmationStatus: string | null = null): RosterPerson => ({ userId, name, role, active, confirmationStatus })
  return [p(ME, 'Tim', 'participant'), p(SAM, 'Sam', 'participant'), p(ANA, 'Ana', 'participant'), p(BEN, 'Ben', 'participant'), p(OUT, 'Olly', 'participant', true, 'declined')]
}

export function baseTables(): Record<string, Row[]> {
  const opt = (id: string, section_id: string, title: string, extra: Row = {}): Row => ({ id, section_id, title, status: 'available', locked: false, metadata: null, ...extra })
  return {
    trips: [{ id: TRIP, settlement_snapshot: null, status: 'booking_details', confirmation_enabled: false, chase_settings: null }],
    planning_sections: [
      { id: SEC_OPEN, trip_id: TRIP, title: 'Saturday dinner', status: 'in_progress', metadata: { decision_shape: 'vote' }, voting_method: 'single', vote_deadline: null, updated_at: '2026-11-16T09:00:00Z', section_type: 'activities' },
      { id: SEC_DONE, trip_id: TRIP, title: 'Where to stay', status: 'completed', metadata: { decision_shape: 'vote' }, voting_method: 'single', vote_deadline: null, updated_at: '2026-11-10T09:00:00Z', section_type: 'accommodation' },
      { id: SEC_RANK, trip_id: TRIP, title: 'Activities', status: 'in_progress', metadata: { decision_shape: 'vote' }, voting_method: 'ranked', vote_deadline: null, updated_at: '2026-11-16T09:00:00Z', section_type: 'activities' },
      { id: SEC_OWN, trip_id: TRIP, title: 'Ski hire', status: 'in_progress', metadata: { decision_shape: 'personal' }, voting_method: 'single', vote_deadline: null, updated_at: '2026-11-16T09:00:00Z', section_type: 'equipment' },
      { id: SEC_OTHER_TRIP, trip_id: OTHER_TRIP, title: 'Their question', status: 'in_progress', metadata: null, voting_method: 'single', vote_deadline: null, updated_at: null, section_type: 'activities' },
    ],
    options: [
      opt(OPT_A, SEC_OPEN, "Nando's"),
      opt(OPT_B, SEC_OPEN, 'Wahaca'),
      opt(OPT_C, SEC_OPEN, 'Dishoom', { locked: true }),
      opt(OPT_DONE, SEC_DONE, 'The chalet'),
      opt(OPT_R1, SEC_RANK, 'Kayak'),
      opt(OPT_R2, SEC_RANK, 'Hike'),
      opt(OPT_R3, SEC_RANK, 'Spa'),
      opt(OPT_OWN1, SEC_OWN, 'Skis', { metadata: { pricing: { flat: 30, variants: [{ label: 'Adult', flat: 30 }, { label: 'Kids', flat: 20 }] } } }),
      opt(OPT_OTHER_TRIP, SEC_OTHER_TRIP, 'Foreign option'),
    ],
    option_votes: [],
    selections: [],
    question_passes: [],
    trip_actions: [
      { id: TODO_MINE, trip_id: TRIP, title: 'Book ferry', assigned_to: ME, who_mode: null, completed_at: null, completed_by: null, section_id: null, created_by: SAM },
      { id: TODO_SAMS, trip_id: TRIP, title: "Sam's task", assigned_to: SAM, who_mode: null, completed_at: null, completed_by: null, section_id: null, created_by: SAM },
      { id: TODO_EVERYONE, trip_id: TRIP, title: 'Pack passport', assigned_to: null, who_mode: null, completed_at: null, completed_by: null, section_id: null, created_by: ME },
      { id: TODO_ANYONE, trip_id: TRIP, title: 'Buy snacks', assigned_to: null, who_mode: 'anyone', completed_at: null, completed_by: null, section_id: null, created_by: ME },
      { id: TODO_OTHER_TRIP, trip_id: OTHER_TRIP, title: 'Foreign to-do', assigned_to: ME, who_mode: null, completed_at: null, completed_by: null, section_id: null, created_by: SAM },
    ],
    trip_action_completions: [],
    trip_checklists: [{ id: BRING_FREE, trip_id: TRIP, title: 'Sun cream', assigned_to: null, done: false, created_by: SAM }],
    expenses: [],
    settlements: [],
    trip_timeline_events: [],
  }
}

export interface Harness {
  ctx: ToolCtx
  db: FakeDb
  emitted: ChatActionEnvelope[]
}

export function makeCtx(opts: {
  tables?: Record<string, Row[]>
  me?: Partial<ToolCtx['me']>
  actionsEnabled?: boolean
  admin?: boolean
  trip?: Partial<ToolCtx['trip']>
  proposed?: number
  rosterOverride?: RosterPerson[]
  userId?: string
} = {}): Harness {
  const db = newDb(opts.tables ?? baseTables())
  const emitted: ChatActionEnvelope[] = []
  const userId = opts.userId ?? ME
  const r = opts.rosterOverride ?? roster()
  const meRow = r.find((p) => p.userId === userId)
  const ctx: ToolCtx = {
    client: fakeClient(db, 'user'),
    admin: opts.admin === false ? null : fakeClient(db, 'admin'),
    tripId: TRIP,
    userId,
    turnId: TURN,
    trip: {
      id: TRIP,
      name: 'Alps',
      location: 'Chamonix',
      start_date: '2026-12-05',
      end_date: '2026-12-12',
      status: 'booking_details',
      base_currency: 'GBP',
      created_by: ME,
      confirmation_enabled: false,
      confirmation_deadline: null,
      settlement_snapshot: null,
      ...opts.trip,
    },
    roster: r,
    me: {
      userId,
      name: meRow?.name ?? 'Tim',
      canManageTrip: false,
      isSiteAdmin: false,
      isOnRoster: !!meRow,
      isComing: !!meRow && meRow.active && meRow.confirmationStatus !== 'declined',
      isOut: !meRow || !meRow.active || meRow.confirmationStatus === 'declined' || meRow.confirmationStatus === 'cancelled',
      ...opts.me,
    },
    actionsEnabled: opts.actionsEnabled ?? true,
    today: '2026-11-17',
    now: new Date('2026-11-17T10:00:00Z'),
    proposedThisTurn: { count: opts.proposed ?? 0 },
    emitAction: (a) => emitted.push(a),
    memo: new Map(),
  }
  return { ctx, db, emitted }
}

export function organiser(extra: Parameters<typeof makeCtx>[0] = {}): Harness {
  return makeCtx({ ...extra, me: { canManageTrip: true, ...(extra.me ?? {}) } })
}

/** Rows written by the service role to chat_actions. */
export function actionRows(db: FakeDb): Row[] {
  return db.writes.filter((w) => w.table === 'chat_actions' && w.op === 'insert').map((w) => w.row!)
}

/** Every write that is NOT a chat_actions insert by the service role. Must be empty after any propose tool. */
export function forbiddenWrites(db: FakeDb): WriteRecord[] {
  return db.writes.filter((w) => !(w.by === 'admin' && w.table === 'chat_actions' && w.op === 'insert'))
}
