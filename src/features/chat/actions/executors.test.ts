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
import { answerParams, envelope, expenseParams, liveFixture, ANA, BEN, ME, SAM, todoParams } from '../lib/chatFixtures'
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
