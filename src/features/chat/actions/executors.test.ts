import { describe, it, expect, vi, beforeEach } from 'vitest'

type Insert = { table: string; rows: unknown }
const inserts: Insert[] = []
vi.mock('../../../lib/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn() },
    rpc: vi.fn(),
    from: (table: string) => ({
      insert: (rows: unknown) => {
        inserts.push({ table, rows })
        return {
          select: () => ({ single: async () => ({ data: { id: 'exp-1', description: 'Taxis' }, error: null }) }),
          then: (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res),
        }
      },
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  },
}))

import { moduleFor } from './index'
import { buildExpenseDraft } from './addExpense'
import { createExpenseWithSplits } from '../../../lib/queries/useExpenses'
import type { ChatDeps } from './deps'
import type { ExecCtx } from './types'
import { answerParams, envelope, expenseParams, liveFixture, planItemParams, travelEvent, travelParams, ANA, BEN, ME, SAM, todoParams } from '../lib/chatFixtures'
import type { AddExpenseParams } from '../lib/payload'

function fakeDeps(): { [K in keyof ChatDeps]: ReturnType<typeof vi.fn> } {
  return {
    createTodo: vi.fn(async () => ({ id: 'todo-1' })),
    toggleTodo: vi.fn(async () => ({ undo: { fn: 'toggleTodo', args: ['t1', { actionId: 'a1', isGroupAction: false, userId: ME, done: false }], label: 'x' } })),
    claimTodo: vi.fn(async () => ({ undo: { fn: 'claimTodo', args: [{ id: 'a2', userId: ME, claim: false }], label: 'x' } })),
    toggleChecklistItem: vi.fn(async () => ({ undo: { fn: 'toggleChecklistItem', args: [{ id: 'c1', done: false, doneBy: ME }], label: 'x' } })),
    claimChecklistItem: vi.fn(async () => ({ undo: { fn: 'claimChecklistItem', args: [{ id: 'c1', userId: ME, claim: false }], label: 'x' } })),
    answerQuestion: vi.fn(async () => ({ plan: { addedOptionId: 'o1' }, undo: null })),
    addOptionToQuestion: vi.fn(async () => ({ id: 'opt-9', title: 'Pizza East' })),
    suggestOption: vi.fn(async () => ({ option_id: 'o9', section_id: 'q1', trip_id: 't1', created_section: false })),
    createExpenseWithSplits: vi.fn(async () => ({ id: 'exp-1', description: 'Taxis' })),
    createQuestionWithOptions: vi.fn(async () => ({ id: 'sec-1' })),
    deleteTodo: vi.fn(async () => undefined),
    setMyTravel: vi.fn(async (_t: string, legs: unknown[]) => ({ legs: legs.map((_, i) => ({ id: `new-${i}`, direction: 'arrival', leg: 'main' })) })),
    saveMyPlanItem: vi.fn(async (_t: string, id: string | null, item: unknown) => ({ id: item === null ? null : (id ?? 'plan-1') })),
    createHappening: vi.fn(async () => ({ id: 'ev-9' })),
    deleteTimelineEvent: vi.fn(async () => undefined),
  }
}

function mkCtx(over: { live?: ReturnType<typeof liveFixture>; deps?: ReturnType<typeof fakeDeps> } = {}) {
  const deps = over.deps ?? fakeDeps()
  const live = over.live ?? liveFixture()
  const ctx: ExecCtx = {
    tripId: 't1',
    userId: ME,
    queryClient: { invalidateQueries: vi.fn(), refetchQueries: vi.fn() } as never,
    live: () => live,
    refresh: vi.fn(async () => undefined),
    logActivity: vi.fn(),
    deps: deps as unknown as ChatDeps,
    now: () => new Date('2026-11-17T12:00:00Z'),
  }
  return { ctx, deps }
}

beforeEach(() => {
  inserts.length = 0
})

describe('nothing runs while a card is only shown', () => {
  it('validate, view and recheck never call a write function', () => {
    const { deps } = mkCtx()
    const live = liveFixture()
    for (const [kind, params] of [
      ['add_todo', todoParams()],
      ['answer', answerParams()],
      ['add_expense', expenseParams()],
    ] as const) {
      const mod = moduleFor(kind)!
      const a = envelope(kind, params)
      mod.validate(a.params)
      mod.view(a, live)
      mod.recheck(a, live)
    }
    for (const fn of Object.values(deps)) expect(fn).not.toHaveBeenCalled()
  })
})

describe('add_todo', () => {
  it('calls createTodo with the form builder columns for a person, with a date', async () => {
    const { ctx, deps } = mkCtx()
    const out = await moduleFor('add_todo')!.execute(envelope('add_todo', todoParams()), ctx)
    expect(deps.createTodo).toHaveBeenCalledWith('t1', {
      title: 'Book the ferry',
      notes: null,
      assigned_to: SAM,
      deadline_kind: 'fixed',
      due_date: '2026-11-21',
      section_id: null,
      created_by: ME,
    })
    expect(out.result).toEqual({ created_id: 'todo-1' })
  })
  it('anyone / everyone / before the trip map the way the to-do form maps them', async () => {
    const { ctx, deps } = mkCtx()
    await moduleFor('add_todo')!.execute(envelope('add_todo', todoParams({ mode: 'anyone', person_id: null, before_trip: true, due_date: null, notes: 'n' })), ctx)
    expect(deps.createTodo).toHaveBeenLastCalledWith('t1', expect.objectContaining({ assigned_to: null, who_mode: 'anyone', deadline_kind: 'before_trip', due_date: null, notes: 'n', created_by: ME }))
    await moduleFor('add_todo')!.execute(envelope('add_todo', todoParams({ mode: 'everyone', person_id: null })), ctx)
    expect(deps.createTodo).toHaveBeenLastCalledWith('t1', expect.objectContaining({ assigned_to: null }))
  })
  it('undo deletes the created row', async () => {
    const { ctx, deps } = mkCtx()
    await moduleFor('add_todo')!.undo!(envelope('add_todo', todoParams(), { result: { created_id: 'todo-1' } }), ctx)
    expect(deps.deleteTodo).toHaveBeenCalledWith('t1', 'todo-1')
  })
  it('re-check refuses a person who left, and a finished trip', () => {
    const live = liveFixture({ roster: liveFixture().roster.map((p) => (p.user_id === SAM ? { ...p, active: false } : p)) })
    expect(moduleFor('add_todo')!.recheck(envelope('add_todo', todoParams()), live)).toMatch(/Sam is no longer/)
    expect(moduleFor('add_todo')!.recheck(envelope('add_todo', todoParams()), liveFixture({ finished: true }))).toMatch(/finished/)
  })
})

describe('tick_todo', () => {
  const tick = (over: Record<string, unknown>, extra = {}) => envelope('tick_todo', { source: 'action', id: 'a1', op: 'tick', user_id: ME, is_group_action: false, anyone: false, done: true, claim: null, ...over }, { requires: 'tap', ...extra })
  it('routes each op to the matching shared function with the exact arguments', async () => {
    const { ctx, deps } = mkCtx()
    const m = moduleFor('tick_todo')!
    await m.execute(tick({}), ctx)
    expect(deps.toggleTodo).toHaveBeenCalledWith('t1', { actionId: 'a1', isGroupAction: false, userId: ME, done: true, anyone: false })
    await m.execute(tick({ op: 'untick', done: false, is_group_action: true }), ctx)
    expect(deps.toggleTodo).toHaveBeenLastCalledWith('t1', { actionId: 'a1', isGroupAction: true, userId: ME, done: false, anyone: false })
    await m.execute(tick({ id: 'a2', op: 'claim', done: null, claim: true }), ctx)
    expect(deps.claimTodo).toHaveBeenCalledWith({ id: 'a2', userId: ME, claim: true })
    await m.execute(tick({ source: 'checklist', id: 'c1' }), ctx)
    expect(deps.toggleChecklistItem).toHaveBeenCalledWith({ id: 'c1', done: true, doneBy: ME })
    await m.execute(tick({ source: 'checklist', id: 'c1', op: 'give_back', done: null, claim: false }), ctx)
    expect(deps.claimChecklistItem).toHaveBeenCalledWith({ id: 'c1', userId: ME, claim: false })
  })
  it('stores the undo and runs it through the same function', async () => {
    const { ctx, deps } = mkCtx()
    const m = moduleFor('tick_todo')!
    const out = await m.execute(tick({}), ctx)
    await m.undo!(tick({}, { status: 'done', result: out.result }), ctx)
    expect(deps.toggleTodo).toHaveBeenLastCalledWith('t1', { actionId: 'a1', isGroupAction: false, userId: ME, done: false })
  })
  it('refuses an undo descriptor that names anything else', async () => {
    const { ctx } = mkCtx()
    await expect(moduleFor('tick_todo')!.undo!(tick({}, { result: { undo: { fn: 'deleteEverything', args: [] } } }), ctx)).rejects.toThrow()
  })
  it('re-check: already done, already taken, someone else\'s account', () => {
    const m = moduleFor('tick_todo')!
    const done = liveFixture({ actions: [{ id: 'a1', title: 'Book the ferry', completed_at: 'x', assigned_to: ME, trip_action_completions: [] }] as never })
    expect(m.recheck(tick({}), done)).toMatch(/already ticked/)
    const taken = liveFixture({ actions: [{ id: 'a2', title: 'P', completed_at: null, assigned_to: SAM, trip_action_completions: [] }] as never })
    expect(m.recheck(tick({ id: 'a2', op: 'claim', done: null, claim: true }), taken)).toMatch(/taken/)
    expect(m.recheck(tick({ user_id: SAM }), liveFixture())).toMatch(/different account/)
    expect(m.recheck(tick({}), liveFixture())).toBeNull()
  })
})

describe('answer', () => {
  it('plans each step from fresh data, in order, with the payload actions exactly', async () => {
    const { ctx, deps } = mkCtx()
    const steps = [{ type: 'clear' }, { type: 'pick', optionId: 'o2' }, { type: 'pick', optionId: 'o1' }]
    const p = answerParams({ mode: 'ranked', option_ids: ['o2', 'o1'], ranks: [1, 2], answer_actions: steps })
    const out = await moduleFor('answer')!.execute(envelope('answer', p, { requires: 'tap' }), ctx)
    const calls = deps.answerQuestion.mock.calls as unknown as Array<[{ action: unknown; userId: string }]>
    expect(calls.map((c) => c[0].action)).toEqual(steps)
    expect(calls.every((c) => c[0].userId === ME)).toBe(true)
    // refreshed once up front, once before every step, and once more to record what the answer became (for Undo)
    expect((ctx.refresh as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2 + steps.length)
    expect(ctx.logActivity).toHaveBeenCalledWith(expect.objectContaining({ verb: 'vote_cast', metadata: expect.objectContaining({ via: 'assistant' }) }))
    expect(out.result.undo).toBeTruthy()
  })
  it('is refused through the gate when the question is decided', () => {
    const live = liveFixture()
    ;(live.sections[0] as { status: string }).status = 'completed'
    expect(moduleFor('answer')!.recheck(envelope('answer', answerParams()), live)).toBeTruthy()
  })
  it('re-check notices that my answer changed since the suggestion', () => {
    const basis = { my_previous: { votes: [], pass: null, selections: [] } }
    const live = liveFixture({ votes: [{ id: 'v', option_id: 'o2', user_id: ME, rank: null }] as never })
    expect(moduleFor('answer')!.recheck(envelope('answer', answerParams(), { basis }), live)).toMatch(/answer changed/)
    expect(moduleFor('answer')!.recheck(envelope('answer', answerParams(), { basis }), liveFixture())).toBeNull()
  })
  it('undo puts the earlier answer back (clear, then picks in rank order)', async () => {
    const { ctx, deps } = mkCtx()
    const prev = { sectionId: 'q1', userId: ME, votes: [{ optionId: 'o3', rank: 2 }, { optionId: 'o2', rank: 1 }], pass: null, selections: [] }
    await moduleFor('answer')!.undo!(envelope('answer', answerParams(), { result: { undo: { previous: prev } } }), ctx)
    const calls = deps.answerQuestion.mock.calls as unknown as Array<[{ action: unknown }]>
    expect(calls.map((c) => c[0].action)).toEqual([{ type: 'clear' }, { type: 'pick', optionId: 'o2' }, { type: 'pick', optionId: 'o3' }])
  })
})

describe('suggest_option / questions / options', () => {
  it('suggest_option passes exactly the payload (idea with no question too)', async () => {
    const { ctx, deps } = mkCtx()
    const m = moduleFor('suggest_option')!
    await m.execute(envelope('suggest_option', { section_id: 'q1', idea: false, title: 'Pizza Pilgrims', note: 'n', link: 'https://example.com/p' }), ctx)
    expect(deps.suggestOption).toHaveBeenLastCalledWith('t1', { sectionId: 'q1', title: 'Pizza Pilgrims', link: 'https://example.com/p', note: 'n' })
    await m.execute(envelope('suggest_option', { section_id: null, idea: true, title: 'Karaoke', note: null, link: 'javascript:alert(1)' }), ctx)
    expect(deps.suggestOption).toHaveBeenLastCalledWith('t1', { sectionId: null, title: 'Karaoke', link: undefined, note: undefined, idea: true })
  })
  it('create_question builds the form values the add flow would hold', async () => {
    const { ctx, deps } = mkCtx()
    const p = { title: 'Brunch?', shape: 'vote', method: 'ranked', section_type: 'activities', answer_by: null, hide_results: true, currency: 'GBP', price_basis: 'each', options: [{ title: 'Cafe A', note: null, price: '12.00', price_minor: 1200 }, { title: 'Cafe B', note: null, price: null, price_minor: null }] }
    await moduleFor('create_question')!.execute(envelope('create_question', p), ctx)
    expect(deps.createQuestionWithOptions).toHaveBeenCalledWith('t1', expect.objectContaining({ title: 'Brunch?', optionsText: 'Cafe A\nCafe B', method: 'ranked', shape: 'vote', hideResults: true, prices: { 'cafe a': '12.00' }, currency: 'GBP' }))
  })
  it('create_question and add_option are organiser-only at re-check', () => {
    const live = liveFixture({ canManage: false })
    expect(moduleFor('create_question')!.recheck(envelope('create_question', {}), live)).toMatch(/organizers/)
    expect(moduleFor('add_option')!.recheck(envelope('add_option', { section_id: 'q1' }), live)).toMatch(/organizers/)
  })
  it('add_option writes the form row for the question, with the note and the next place in the list', async () => {
    const { ctx, deps } = mkCtx()
    await moduleFor('add_option')!.execute(envelope('add_option', { section_id: 'q1', shape: 'vote', title: 'Pizza East', note: 'near', price: '15.00', price_minor: 1500, currency: 'GBP', price_basis: 'each' }), ctx)
    expect(deps.addOptionToQuestion).toHaveBeenCalledWith(expect.objectContaining({ section_id: 'q1', title: 'Pizza East', description: 'near', order_index: 3, price: 15, currency: 'GBP' }))
  })
})

describe('add_expense parity: the split on the card is the split the shared function writes, penny for penny', () => {
  const cases: Array<[string, Partial<AddExpenseParams> & Record<string, unknown>]> = [
    ['even split of £40 over four', {}],
    ['£10.00 over three: the extra penny goes first', { amount_minor: 1000, splits: [{ user_id: ME, amount_minor: 334 }, { user_id: SAM, amount_minor: 333 }, { user_id: ANA, amount_minor: 333 }] }],
    ['the server put the extra penny last: explicit amounts win', { amount_minor: 1000, splits: [{ user_id: ME, amount_minor: 333 }, { user_id: SAM, amount_minor: 333 }, { user_id: ANA, amount_minor: 334 }] }],
    ['custom amounts', { split_mode: 'custom', amount_minor: 4500, splits: [{ user_id: ME, amount_minor: 2000 }, { user_id: SAM, amount_minor: 1750 }, { user_id: BEN, amount_minor: 750 }] }],
    ['a zero-decimal currency', { currency: 'JPY', exponent: 0, base_currency: 'JPY', amount_minor: 1001, splits: [{ user_id: ME, amount_minor: 501 }, { user_id: SAM, amount_minor: 500 }] }],
    ['pennies that float badly (£0.07 over three)', { amount_minor: 7, splits: [{ user_id: ME, amount_minor: 3 }, { user_id: SAM, amount_minor: 2 }, { user_id: ANA, amount_minor: 2 }] }],
  ]
  for (const [name, over] of cases) {
    it(name, async () => {
      const params = expenseParams(over) as unknown as AddExpenseParams
      const { draft, amountMajor } = buildExpenseDraft(params, ME)
      await createExpenseWithSplits('t1', { draft, amountMajor, receiptUrl: null, baseCurrency: params.base_currency })
      const exp = inserts.find((i) => i.table === 'expenses')!.rows as Record<string, unknown>
      const splits = inserts.find((i) => i.table === 'expense_splits')!.rows as Array<{ user_id: string; amount: number; split_type: string }>
      const scale = 10 ** params.exponent
      // what the card shows == what is written
      expect(splits.map((s) => [s.user_id, Math.round(s.amount * scale)])).toEqual(params.splits.map((s) => [s.user_id, s.amount_minor]))
      expect(splits.reduce((a, s) => a + Math.round(s.amount * scale), 0)).toBe(params.amount_minor)
      expect(Math.round((exp.amount as number) * scale)).toBe(params.amount_minor)
      expect(exp).toMatchObject({ trip_id: 't1', description: 'Taxis', currency: params.currency, category: 'transport', paid_by: ME, payment_date: '2026-11-20', participant_ids: params.splits.map((s) => s.user_id) })
    })
  }
  it('an even split stays an "equal" split like the screen\'s; a lopsided one is "custom"', async () => {
    expect(buildExpenseDraft(expenseParams() as unknown as AddExpenseParams, ME).draft.splitMode).toBe('equal')
    expect(buildExpenseDraft(expenseParams({ amount_minor: 1000, splits: [{ user_id: ME, amount_minor: 333 }, { user_id: SAM, amount_minor: 333 }, { user_id: ANA, amount_minor: 334 }] }) as unknown as AddExpenseParams, ME).draft.splitMode).toBe('custom')
  })
  it('refuses shares that do not add up, before anything is written', () => {
    expect(() => buildExpenseDraft(expenseParams({ amount_minor: 4001 }) as unknown as AddExpenseParams, ME)).toThrow(/add up/)
  })
  it('execute calls the shared function once with the draft and logs "via assistant"', async () => {
    const { ctx, deps } = mkCtx()
    const out = await moduleFor('add_expense')!.execute(envelope('add_expense', expenseParams()), ctx)
    expect(deps.createExpenseWithSplits).toHaveBeenCalledTimes(1)
    const [tripId, values] = deps.createExpenseWithSplits.mock.calls[0] as unknown as [string, { draft: { description: string; paidBy: string }; amountMajor: number; receiptUrl: null; baseCurrency: string }]
    expect(tripId).toBe('t1')
    expect(values).toMatchObject({ amountMajor: 40, receiptUrl: null, baseCurrency: 'GBP', draft: { description: 'Taxis', paidBy: ME } })
    expect(out.result).toEqual({ expense_id: 'exp-1' })
    expect(ctx.logActivity).toHaveBeenCalledWith(expect.objectContaining({ verb: 'expense_added', metadata: expect.objectContaining({ via: 'assistant' }) }))
  })
  it('frozen trip: plain refusal at re-check', () => {
    expect(moduleFor('add_expense')!.recheck(envelope('add_expense', expenseParams()), liveFixture({ frozen: true }))).toMatch(/frozen/i)
  })
})


describe('set_travel', () => {
  const mod = moduleFor('set_travel')!
  const tapped = (over: Record<string, unknown> = {}) => envelope('set_travel', travelParams(over), { requires: 'tap', basis: { replaces_updated_at: null } })
  const replacing = (over: Record<string, unknown> = {}) =>
    envelope('set_travel', travelParams({ id: 'ev-arr', replaces_event_id: 'ev-arr', ...over }), { basis: { replaces_updated_at: '2026-11-02T10:00:00Z' } })
  const withSaved = (extra: unknown[] = []) => liveFixture({ events: [travelEvent(), ...extra] as never })

  it('adds a new main leg to the live legs and sends the whole set', async () => {
    const live = liveFixture({ events: [travelEvent({ id: 'ev-dep', title: 'Departure', event_date: '2026-12-13' }, { direction: 'departure' })] as never })
    const { ctx, deps } = mkCtx({ live })
    const out = await mod.execute(tapped(), ctx)
    const [tripId, legs] = deps.setMyTravel.mock.calls[0] as unknown as [string, Array<Record<string, unknown>>]
    expect(tripId).toBe('t1')
    expect(legs.map((l) => [l.direction, l.leg, l.id])).toEqual([['departure', 'main', 'ev-dep'], ['arrival', 'main', null]])
    expect(legs[1]).toMatchObject({ date: '2026-12-03', time: '10:00', flightRef: 'JL044', airportCode: 'HND', setOffDate: '2026-12-02', setOffTime: '21:00' })
    expect(deps.setMyTravel.mock.calls[0][2]).toEqual(['ev-dep'])
    expect(out.doneText).toBe('Travel saved.')
    expect((out.result.before as unknown[]).length).toBe(1)
    expect(out.result.after_ids).toEqual(['new-0', 'new-1'])
  })
  it('replaces the live main leg and keeps its id from the live row, not the card', async () => {
    const { ctx, deps } = mkCtx({ live: withSaved() })
    await mod.execute(replacing({ id: 'forged', date: '2026-12-02' }), ctx)
    const legs = deps.setMyTravel.mock.calls[0][1] as Array<Record<string, unknown>>
    expect(legs).toHaveLength(1)
    expect(legs[0]).toMatchObject({ id: 'ev-arr', date: '2026-12-02' })
  })
  it('an extra leg is appended and the saved legs are all sent', async () => {
    const { ctx, deps } = mkCtx({ live: withSaved() })
    await mod.execute(tapped({ leg: 'extra', title: 'Flight to Tokyo', set_off_date: null, set_off_time: null }), ctx)
    const legs = deps.setMyTravel.mock.calls[0][1] as Array<Record<string, unknown>>
    expect(legs.map((l) => [l.leg, l.id])).toEqual([['main', 'ev-arr'], ['extra', null]])
  })
  it('refuses a replace when the live main leg is not the one the card was made against', () => {
    expect(mod.recheck(replacing(), withSaved())).toBeNull()
    expect(mod.recheck(replacing({ replaces_event_id: 'ev-other' }), withSaved())).toBe('Your travel has changed since. Open travel details to check.')
    expect(mod.recheck(replacing(), liveFixture())).toBe('Your travel has changed since. Open travel details to check.')
    const edited = liveFixture({ events: [travelEvent({ updated_at: '2026-11-05T10:00:00Z' })] as never })
    expect(mod.recheck(replacing(), edited)).toBe('Your travel has changed since. Open travel details to check.')
    // a card made for a new leg, but one has been saved since
    expect(mod.recheck(tapped(), withSaved())).toBe('Your travel has changed since. Open travel details to check.')
  })
  it('re-check: finished trip, and too many extra journeys, in plain words', () => {
    expect(mod.recheck(tapped(), liveFixture({ finished: true }))).toMatch(/finished/)
    const extras = ['a', 'b', 'c'].map((n, i) => travelEvent({ id: `x${n}`, title: `Flight ${n}`, event_date: `2026-12-0${i + 1}` }, { leg: 'extra' }))
    expect(mod.recheck(tapped({ leg: 'extra', title: 'One more', set_off_date: null, set_off_time: null }), liveFixture({ events: extras as never }))).toMatch(/up to 3 extra/)
  })
  it('a dates-outside-the-trip card is not blocked by anything but the shared rules', () => {
    expect(mod.recheck(tapped({ date: '2026-12-30', set_off_date: null, set_off_time: null }), liveFixture())).toBeNull()
  })
  it('never shows raw database text when the save fails', async () => {
    const deps = fakeDeps()
    deps.setMyTravel.mockRejectedValueOnce({ message: 'duplicate key value violates unique constraint "x"', code: '23505' })
    const { ctx } = mkCtx({ deps })
    await expect(mod.execute(tapped(), ctx)).rejects.toThrow("Couldn't save your travel. Check your connection and try again.")
    deps.setMyTravel.mockRejectedValueOnce({ message: 'Setting off must be on or up to 3 days before arriving.', hint: 'bad_set_off' })
    await expect(mod.execute(tapped(), ctx)).rejects.toThrow(/Setting off must be/)
  })
  it('undo sends the legs from before; a row that is gone goes as a new leg; nothing else is touched', async () => {
    const before = [{ id: 'ev-arr', direction: 'arrival', leg: 'main', title: null, date: '2026-12-04', time: '09:30', flightRef: 'BA117', airportCode: null, setOffDate: null, setOffTime: null, homeDate: null, homeTime: null }]
    const after = [{ ...before[0], date: '2026-12-02' }]
    const done = replacing({ date: '2026-12-02' })
    done.result = { before, after, after_ids: ['ev-arr'] }
    const live = liveFixture({ events: [travelEvent({ event_date: '2026-12-02' })] as never })
    expect(mod.undoBlocked!(done, live)).toBeNull()
    const { ctx, deps } = mkCtx({ live })
    await mod.undo!(done, ctx)
    expect(deps.setMyTravel).toHaveBeenCalledWith('t1', [expect.objectContaining({ id: 'ev-arr', date: '2026-12-04' })], ['ev-arr'])
    // the original row no longer exists (deleted and re-created on the way): send it as new
    const gone = { ...done, result: { before: [{ ...before[0], id: 'old' }], after } }
    await mod.undo!(gone, ctx)
    expect(deps.setMyTravel.mock.calls[1][1]).toEqual([expect.objectContaining({ id: null, date: '2026-12-04' })])
  })
  it('undo of a first-ever leg clears it (an empty set), and is blocked once the legs differ from what was saved', async () => {
    const after = [{ id: 'n0', direction: 'arrival', leg: 'main', title: null, date: '2026-12-03', time: '10:00', flightRef: 'JL044', airportCode: 'HND', setOffDate: '2026-12-02', setOffTime: '21:00', homeDate: null, homeTime: null }]
    const done = { ...tapped(), result: { before: [], after, after_ids: ['n0'] } }
    const same = liveFixture({ events: [travelEvent({ id: 'n0', event_date: '2026-12-03', start_time: '10:00:00' }, { flight_ref: 'JL044', airport_code: 'HND', set_off_date: '2026-12-02', set_off_time: '21:00' })] as never })
    expect(mod.undoBlocked!(done, same)).toBeNull()
    const { ctx, deps } = mkCtx({ live: same })
    await mod.undo!(done, ctx)
    expect(deps.setMyTravel).toHaveBeenCalledWith('t1', [], ['n0'])
    const changed = liveFixture({ events: [travelEvent({ id: 'n0', event_date: '2026-12-09' })] as never })
    expect(mod.undoBlocked!(done, changed)).toMatch(/changed since/)
    expect(mod.undoBlocked!({ ...done, result: null }, same)).toBe('Nothing to undo.')
  })
  it('refuses when the timeline is not loaded, and never writes', async () => {
    const live = liveFixture({ events: undefined })
    const msg = "Your travel couldn't be checked just now. Open travel details to check."
    expect(mod.recheck(tapped(), live)).toBe(msg)
    const { ctx, deps } = mkCtx({ live })
    await expect(mod.execute(tapped(), ctx)).rejects.toThrow(msg)
    await expect(mod.undo!({ ...tapped(), result: { before: [], after: [] } }, ctx)).rejects.toThrow(msg)
    expect(mod.undoBlocked!({ ...tapped(), result: { before: [], after: [] } }, live)).toBe(msg)
    expect(deps.setMyTravel).not.toHaveBeenCalled()
  })
  it('a server "stale" refusal reads as the changed-since message', async () => {
    const deps = fakeDeps()
    deps.setMyTravel.mockRejectedValueOnce({ message: 'Your travel has changed since you opened this. Close it, open it again and check.', hint: 'stale' })
    const { ctx } = mkCtx({ deps })
    await expect(mod.execute(tapped(), ctx)).rejects.toThrow('Your travel has changed since. Open travel details to check.')
  })
  it('validate fails closed on malformed params', () => {
    expect(mod.validate(travelParams())).toBe(true)
    expect(mod.validate(travelParams({ direction: 'sideways' }))).toBe(false)
    expect(mod.validate(travelParams({ date: 'soon' }))).toBe(false)
    expect(mod.validate(travelParams({ leg: 'extra', title: null }))).toBe(false)
    expect(mod.validate({})).toBe(false)
  })
})

describe('add_plan_item', () => {
  const mod = moduleFor('add_plan_item')!
  const mine = () => envelope('add_plan_item', planItemParams(), { requires: 'tap' })
  const everyone = (over: Record<string, unknown> = {}) => envelope('add_plan_item', planItemParams({ for: 'everyone', ...over }))

  it('for me does not need the timeline to be loaded', async () => {
    const { ctx, deps } = mkCtx({ live: liveFixture({ events: undefined }) })
    await mod.execute(mine(), ctx)
    expect(deps.saveMyPlanItem).toHaveBeenCalled()
    expect(mod.recheck(mine(), liveFixture({ events: undefined }))).toBeNull()
  })
  it('for me goes through saveMyPlanItem with the Add form builder values', async () => {
    const { ctx, deps } = mkCtx()
    const out = await mod.execute(mine(), ctx)
    expect(deps.saveMyPlanItem).toHaveBeenCalledWith('t1', null, { title: 'Dinner in Tokyo', date: '2026-12-02', startTime: '19:00', endTime: '21:00', notes: null, placeId: null, location: null, category: 'dining' })
    expect(deps.createHappening).not.toHaveBeenCalled()
    expect(out).toEqual({ result: { created_id: 'plan-1', for: 'me' }, doneText: 'Added to the plan.' })
  })
  it('an all-day item sends no times; a late end is kept (runs into the next day)', async () => {
    const { ctx, deps } = mkCtx()
    await mod.execute(envelope('add_plan_item', planItemParams({ start_time: null, end_time: null })), ctx)
    expect(deps.saveMyPlanItem.mock.calls[0][2]).toMatchObject({ startTime: null, endTime: null })
    await mod.execute(envelope('add_plan_item', planItemParams({ start_time: '22:00', end_time: '02:00' })), ctx)
    expect(deps.saveMyPlanItem.mock.calls[1][2]).toMatchObject({ startTime: '22:00', endTime: '02:00' })
  })
  it('for everyone goes through createHappening (organisers)', async () => {
    const { ctx, deps } = mkCtx()
    const out = await mod.execute(everyone(), ctx)
    expect(deps.createHappening).toHaveBeenCalledWith('t1', ME, expect.objectContaining({ title: 'Dinner in Tokyo', day: '2026-12-02', hasTime: true, startTime: '19:00', endTime: '21:00', attendeeIds: [] }))
    expect(deps.saveMyPlanItem).not.toHaveBeenCalled()
    expect(out.result).toEqual({ created_id: 'ev-9', for: 'everyone' })
    expect(ctx.logActivity).toHaveBeenCalledWith(expect.objectContaining({ verb: 'event_added', entity: expect.objectContaining({ type: 'timeline_event', label: 'Dinner in Tokyo' }) }))
  })
  it('a member asking for everyone is refused at re-check and at execute, and nothing is written', async () => {
    const live = liveFixture({ canManage: false })
    expect(mod.recheck(everyone(), live)).toBe('Only organisers can add to the group plan.')
    expect(mod.recheck(mine(), live)).toBeNull()
    const { ctx, deps } = mkCtx({ live })
    await expect(mod.execute(everyone(), ctx)).rejects.toThrow(/Only organisers/)
    expect(deps.createHappening).not.toHaveBeenCalled()
  })
  it('finished trip is refused at re-check', () => {
    expect(mod.recheck(mine(), liveFixture({ finished: true }))).toMatch(/finished/)
  })
  it('never shows raw database text', async () => {
    const deps = fakeDeps()
    deps.createHappening.mockRejectedValueOnce({ message: 'new row violates row-level security policy for table "trip_timeline_events"', code: '42501' })
    const { ctx } = mkCtx({ deps })
    await expect(mod.execute(everyone(), ctx)).rejects.toThrow("Couldn't save that. Check your connection and try again.")
  })
  it('undo: a just-me item through saveMyPlanItem(id, null), an everyone item through deleteTimelineEvent', async () => {
    const row = travelEvent({ id: 'plan-1', title: 'Dinner in Tokyo', event_date: '2026-12-02' })
    const live = liveFixture({ events: [row] as never })
    const { ctx, deps } = mkCtx({ live })
    const a = { ...mine(), result: { created_id: 'plan-1', for: 'me' } }
    expect(mod.undoBlocked!(a, live)).toBeNull()
    await mod.undo!(a, ctx)
    expect(deps.saveMyPlanItem).toHaveBeenCalledWith('t1', 'plan-1', null)
    await mod.undo!({ ...everyone(), result: { created_id: 'plan-1', for: 'everyone' } }, ctx)
    expect(deps.deleteTimelineEvent).toHaveBeenCalledWith('t1', 'plan-1')
  })
  it('undo is blocked when the item is gone or has been renamed', () => {
    const a = { ...mine(), result: { created_id: 'plan-1', for: 'me' } }
    expect(mod.undoBlocked!(a, liveFixture())).toMatch(/already gone/)
    expect(mod.undoBlocked!(a, liveFixture({ events: [travelEvent({ id: 'plan-1', title: 'Lunch', event_date: '2026-12-02' })] as never }))).toMatch(/changed since/)
    expect(mod.undoBlocked!(mine(), liveFixture())).toBe('Nothing to undo.')
  })
  it('validate fails closed', () => {
    expect(mod.validate(planItemParams())).toBe(true)
    expect(mod.validate(planItemParams({ for: 'sam' }))).toBe(false)
    expect(mod.validate(planItemParams({ title: ' ' }))).toBe(false)
    expect(mod.validate(planItemParams({ date: '2nd' }))).toBe(false)
  })
})
