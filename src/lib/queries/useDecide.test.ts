import { describe, expect, it, vi } from 'vitest'

vi.mock('../supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }))

import { toUnmarkBookedResult, unmarkTodoPlan } from './useBookings'
import { buildDecideRpcArgs, decideQuestionFallback, isRpcMissingError, toDecideResult, toRpcError } from './useDecide'

describe('isRpcMissingError', () => {
  it('recognises a missing function', () => {
    expect(isRpcMissingError({ code: 'PGRST202', message: 'x' }, 'decide_question')).toBe(true)
    expect(isRpcMissingError({ code: '42883', message: 'x' }, 'decide_question')).toBe(true)
    expect(isRpcMissingError({ message: 'Could not find the function public.decide_question(...) in the schema cache' }, 'decide_question')).toBe(true)
  })
  it('does not mistake a real failure for a missing function', () => {
    expect(isRpcMissingError({ code: '42501', message: 'Only trip organizers and admins can do this' }, 'decide_question')).toBe(false)
    expect(isRpcMissingError({ message: 'This question has already been decided' }, 'decide_question')).toBe(false)
    expect(isRpcMissingError(null, 'decide_question')).toBe(false)
  })
})

describe('toRpcError', () => {
  it('keeps the server message, code and hint on a real Error', () => {
    const e = toRpcError({ message: 'Choose the winning option', code: 'P0001', hint: 'option_required' }) as Error & { code?: string; hint?: string }
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toBe('Choose the winning option')
    expect(e.code).toBe('P0001')
    expect(e.hint).toBe('option_required')
  })
  it('falls back to a generic message', () => {
    expect(toRpcError({}, 'Nope').message).toBe('Nope')
    expect(toRpcError('weird').message).toBe('Something went wrong')
  })
})

describe('rpc payloads', () => {
  it('omits empty arguments so the SQL defaults apply', () => {
    expect(buildDecideRpcArgs({ sectionId: 's1' })).toEqual({ p_section_id: 's1', p_option_id: undefined, p_put_on_plan: undefined, p_book_todo: undefined })
    const a = buildDecideRpcArgs({ sectionId: 's1', optionId: 'o1', putOnPlan: { date: '2026-12-01' }, bookTodo: { due_date: '2026-11-30' } })
    expect(a.p_option_id).toBe('o1')
    expect(a.p_put_on_plan).toEqual({ date: '2026-12-01' })
    expect(a.p_book_todo).toEqual({ due_date: '2026-11-30' })
  })
  it('reads the RPC result', () => {
    expect(toDecideResult({ section_id: 's', option_id: 'o', event_id: 'e', action_id: 'a', tied: true, already_decided: false }, 'rpc')).toEqual({
      section_id: 's',
      option_id: 'o',
      event_id: 'e',
      action_id: 'a',
      tied: true,
      already_decided: false,
      source: 'rpc',
    })
    expect(toDecideResult(null, 'fallback')).toMatchObject({ option_id: null, event_id: null, action_id: null, tied: false, source: 'fallback' })
  })
})

// ---- fallback sequence against a scripted fake client ------------------------

type Call = { table: string; op: string; arg?: unknown }

function fakeClient(script: Record<string, unknown>) {
  const calls: Call[] = []
  const from = (table: string) => {
    let op = 'select'
    let arg: unknown
    const result = (): unknown => {
      calls.push({ table, op, arg })
      const r = script[`${table}.${op}`]
      return typeof r === 'function' ? (r as (a: unknown) => unknown)(arg) : (r ?? { data: [], error: null })
    }
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'neq', 'is', 'not', 'order', 'limit']) b[m] = () => b
    b.insert = (a: unknown) => ((op = 'insert'), (arg = a), b)
    b.update = (a: unknown) => ((op = 'update'), (arg = a), b)
    b.delete = () => ((op = 'delete'), b)
    b.maybeSingle = () => Promise.resolve(result())
    b.single = () => Promise.resolve(result())
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej)
    return b
  }
  return { sb: { from } as never, calls }
}

const SECTION = { id: 's1', trip_id: 't1', title: 'Where to stay', status: 'in_progress', metadata: { decision_shape: 'vote' }, section_type: 'accommodation' }
const OPTION = { id: 'o1', title: 'Osaka Airbnb', description: 'near station', place_id: null, status: 'available', section_id: 's1' }

describe('decideQuestionFallback (RPC missing)', () => {
  it('creates event and to-do, then closes with a merged stamp', async () => {
    const { sb, calls } = fakeClient({
      'planning_sections.select': { data: SECTION, error: null },
      'options.select': { data: OPTION, error: null },
      'trip_timeline_events.select': { data: [], error: null },
      'trip_timeline_events.insert': { data: { id: 'e1' }, error: null },
      'trip_actions.insert': { data: { id: 'a1' }, error: null },
      'planning_sections.update': { data: [{ id: 's1' }], error: null },
      'activity_feed.insert': { data: null, error: null },
    })
    const r = await decideQuestionFallback('t1', 'u1', { sectionId: 's1', optionId: 'o1', putOnPlan: { date: '2026-12-01' }, bookTodo: { due_date: '2026-11-30' } }, sb)
    expect(r).toMatchObject({ option_id: 'o1', event_id: 'e1', action_id: 'a1', source: 'fallback', already_decided: false })
    const close = calls.find((c) => c.table === 'planning_sections' && c.op === 'update')!
    expect(close.arg).toEqual({ status: 'completed', metadata: { decision_shape: 'vote', decided_option_id: 'o1', followup_action_id: 'a1' } })
    const todo = calls.find((c) => c.table === 'trip_actions' && c.op === 'insert')!.arg as Record<string, unknown>
    expect(todo.title).toBe('Book: Osaka Airbnb')
    expect(todo.section_id).toBeUndefined() // must not be an "answer this question" to-do
    expect(todo.assigned_to).toBe('u1')
  })

  it('rolls back what it created when closing fails', async () => {
    const { sb, calls } = fakeClient({
      'planning_sections.select': { data: SECTION, error: null },
      'options.select': { data: OPTION, error: null },
      'trip_timeline_events.select': { data: [], error: null },
      'trip_timeline_events.insert': { data: { id: 'e1' }, error: null },
      'trip_actions.insert': { data: { id: 'a1' }, error: null },
      'planning_sections.update': { data: null, error: { message: 'boom' } },
    })
    await expect(decideQuestionFallback('t1', 'u1', { sectionId: 's1', optionId: 'o1', putOnPlan: { date: '2026-12-01' }, bookTodo: {} }, sb)).rejects.toThrow('boom')
    expect(calls.some((c) => c.table === 'trip_timeline_events' && c.op === 'delete')).toBe(true)
    expect(calls.some((c) => c.table === 'trip_actions' && c.op === 'delete')).toBe(true)
  })

  it('is idempotent for the same winner and refuses another', async () => {
    const decided = { ...SECTION, status: 'completed', metadata: { decided_option_id: 'o1' } }
    const { sb } = fakeClient({ 'planning_sections.select': { data: decided, error: null } })
    expect(await decideQuestionFallback('t1', 'u1', { sectionId: 's1', optionId: 'o1' }, sb)).toMatchObject({ already_decided: true, option_id: 'o1' })
    await expect(decideQuestionFallback('t1', 'u1', { sectionId: 's1', optionId: 'o2' }, sb)).rejects.toThrow(/already been decided/)
  })

  it('requires a winner for a Group choice and refuses one for an Own choice', async () => {
    const group = fakeClient({ 'planning_sections.select': { data: SECTION, error: null } })
    await expect(decideQuestionFallback('t1', 'u1', { sectionId: 's1' }, group.sb)).rejects.toThrow('Choose the winning option')
    const own = fakeClient({ 'planning_sections.select': { data: { ...SECTION, metadata: { decision_shape: 'personal' } }, error: null } })
    await expect(decideQuestionFallback('t1', 'u1', { sectionId: 's1', optionId: 'o1' }, own.sb)).rejects.toThrow(/own-choice/)
  })
})

describe('same winner asked again with extras (fallback)', () => {
  const decided = { ...SECTION, status: 'completed', metadata: { decided_option_id: 'o1' } }
  it('creates the missing plan event and to-do without closing again', async () => {
    const { sb, calls } = fakeClient({
      'planning_sections.select': { data: decided, error: null },
      'options.select': { data: OPTION, error: null },
      'trip_timeline_events.select': { data: [], error: null },
      'trip_timeline_events.insert': { data: { id: 'e1' }, error: null },
      'trip_actions.insert': { data: { id: 'a1' }, error: null },
      'planning_sections.update': { data: [{ id: 's1' }], error: null },
    })
    const r = await decideQuestionFallback('t1', 'u1', { sectionId: 's1', optionId: 'o1', putOnPlan: { date: '2026-12-01' }, bookTodo: {} }, sb)
    expect(r).toMatchObject({ already_decided: true, event_id: 'e1', action_id: 'a1' })
    const upd = calls.filter((c) => c.table === 'planning_sections' && c.op === 'update')
    expect(upd).toHaveLength(1)
    expect(upd[0].arg).toEqual({ metadata: { decided_option_id: 'o1', followup_action_id: 'a1' } })
    expect(calls.some((c) => c.table === 'activity_feed')).toBe(false)
  })
  it('truncates a very long option title for the plan event', async () => {
    const { sb, calls } = fakeClient({
      'planning_sections.select': { data: SECTION, error: null },
      'options.select': { data: { ...OPTION, title: 'x'.repeat(300) }, error: null },
      'trip_timeline_events.select': { data: [], error: null },
      'trip_timeline_events.insert': { data: { id: 'e1' }, error: null },
      'planning_sections.update': { data: [{ id: 's1' }], error: null },
    })
    await decideQuestionFallback('t1', 'u1', { sectionId: 's1', optionId: 'o1', putOnPlan: { date: '2026-12-01' } }, sb)
    const ev = calls.find((c) => c.table === 'trip_timeline_events' && c.op === 'insert')!.arg as { title: string }
    expect(ev.title).toHaveLength(200)
  })
})

describe('unmark with reopen', () => {
  it('deletes the Book: to-do when the question reopens, re-opens it otherwise', () => {
    expect(unmarkTodoPlan(true, 'completed')).toBe('delete')
    expect(unmarkTodoPlan(false, 'completed')).toBe('reopen')
    expect(unmarkTodoPlan(true, 'in_progress')).toBe('reopen')
  })
  it('reads action_removed from the RPC result', () => {
    expect(toUnmarkBookedResult({ option_id: 'o', reopened: true, action_removed: true, action_id: null }, 'rpc')).toMatchObject({ action_removed: true, action_id: null })
    expect(toUnmarkBookedResult({}, 'rpc').action_removed).toBe(false)
  })
})
