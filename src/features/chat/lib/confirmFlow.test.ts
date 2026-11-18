import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn(), auth: { getSession: vi.fn() } } }))

import { __resetInFlightForTests, canUndo, cardPhase, confirmAction, dismissAction, failureMessage, undoAction, UNDO_WINDOW_MS, STUCK_AFTER_MS, GENERIC_FAILURE } from './confirmFlow'
import { ACTIONS_OFF_MESSAGE, ChatRpcError, DAILY_CAP_MESSAGE, describeChatRpcError, type ChatRpc } from './chatApi'
import { envelope, expenseParams, liveFixture, ME, SAM, todoParams } from './chatFixtures'
import { FROZEN_WRITE_MESSAGE } from '../../../lib/writeRefusals'
import type { ChatDeps } from '../actions/deps'
import type { ExecCtx } from '../actions/types'
import type { ChatActionEnvelope } from './payload'

const tap = (over: Partial<ChatActionEnvelope> = {}) =>
  envelope('tick_todo', { source: 'action', id: 'a1', op: 'tick', user_id: ME, is_group_action: false, anyone: false, done: true, claim: null }, { requires: 'tap', ...over })

function setup(over: { live?: ReturnType<typeof liveFixture>; rpc?: Partial<ChatRpc>; toggleTodo?: ChatDeps['toggleTodo'] } = {}) {
  const calls: string[] = []
  const begin = vi.fn(async () => (calls.push('begin'), { started: true as const, action: null }))
  const finish = vi.fn(async () => (calls.push('finish'), { finished: true, reason: null, action: null }))
  const dismiss = vi.fn(async () => ({ dismissed: true, reason: null, action: null }))
  const rpc: ChatRpc = {
    begin,
    finish,
    dismiss,
    markEdited: vi.fn(async () => ({ marked: true, reason: null, action: null })),
    ...over.rpc,
  }
  const fns = { begin: over.rpc?.begin ? (over.rpc.begin as unknown as typeof begin) : begin, finish: over.rpc?.finish ? (over.rpc.finish as unknown as typeof finish) : finish, dismiss }
  const toggleTodo = over.toggleTodo ?? vi.fn(async () => (calls.push('execute'), { undo: { fn: 'toggleTodo', args: ['t1', { actionId: 'a1', isGroupAction: false, userId: ME, done: false }], label: 'x' } }))
  const deps = { toggleTodo, createExpenseWithSplits: vi.fn(async () => ({ id: 'e1', description: 'Taxis' })), createTodo: vi.fn(async () => ({ id: 'n1' })) } as unknown as ChatDeps
  const live = over.live ?? liveFixture()
  const ctx: ExecCtx = {
    tripId: 't1',
    userId: ME,
    queryClient: { invalidateQueries: vi.fn(() => (calls.push('invalidate'), Promise.resolve())), refetchQueries: vi.fn() } as never,
    live: () => live,
    refresh: vi.fn(async () => void calls.push('refresh')),
    logActivity: vi.fn(),
    deps,
    now: () => new Date(),
  }
  return { rpc, ctx, calls, deps, fns }
}

beforeEach(() => __resetInFlightForTests())

describe('confirm flow', () => {
  it('re-checks live data, begins, runs the shared function, finishes, then refreshes', async () => {
    const { rpc, ctx, calls, fns } = setup()
    const out = await confirmAction(tap(), { rpc, ctx })
    expect(out.kind).toBe('done')
    expect(calls.slice(0, 4)).toEqual(['refresh', 'begin', 'execute', 'invalidate'])
    expect(calls).toContain('finish')
    expect(fns.finish).toHaveBeenCalledWith('act-tick_todo', true, expect.objectContaining({ undo: expect.anything() }))
  })

  it('a double tap starts the work once (second tap is "busy")', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { rpc, ctx, deps, fns } = setup({ toggleTodo: vi.fn(async () => (await gate, { undo: { fn: 'toggleTodo', args: [], label: '' } })) as never })
    const a = confirmAction(tap(), { rpc, ctx })
    const b = confirmAction(tap(), { rpc, ctx })
    expect((await b).kind).toBe('busy')
    release()
    expect((await a).kind).toBe('done')
    expect(fns.begin).toHaveBeenCalledTimes(1)
    expect(deps.toggleTodo).toHaveBeenCalledTimes(1)
  })

  it('a second device / retry gets already_started and nothing runs', async () => {
    const existing = tap({ status: 'executing' })
    const { rpc, ctx, deps } = setup({ rpc: { begin: vi.fn(async () => ({ started: false as const, reason: 'already_started' as const, action: existing })) } })
    const out = await confirmAction(tap(), { rpc, ctx })
    expect(out).toEqual({ kind: 'already_started', action: existing })
    expect(deps.toggleTodo).not.toHaveBeenCalled()
  })

  it('expired and not_proposed are reported and nothing runs', async () => {
    for (const reason of ['expired', 'not_proposed'] as const) {
      const { rpc, ctx, deps } = setup({ rpc: { begin: vi.fn(async () => ({ started: false as const, reason, action: null })) } })
      expect((await confirmAction(tap(), { rpc, ctx })).kind).toBe(reason)
      expect(deps.toggleTodo).not.toHaveBeenCalled()
    }
  })

  it('stale live data stops before begin_chat_action', async () => {
    const live = liveFixture({ actions: [{ id: 'a1', title: 'Book the ferry', completed_at: 'x', assigned_to: ME, trip_action_completions: [] }] as never })
    const { rpc, ctx, deps, fns } = setup({ live })
    const out = await confirmAction(tap(), { rpc, ctx })
    expect(out).toEqual({ kind: 'stale', reason: expect.stringMatching(/already ticked/) })
    expect(fns.begin).not.toHaveBeenCalled()
    expect(deps.toggleTodo).not.toHaveBeenCalled()
  })

  it('a frozen trip refuses an expense in plain words, before anything starts', async () => {
    const { rpc, ctx, deps } = setup({ live: liveFixture({ frozen: true }) })
    const out = await confirmAction(envelope('add_expense', expenseParams()), { rpc, ctx })
    expect(out.kind).toBe('stale')
    expect((out as { reason: string }).reason).toMatch(/frozen/i)
    expect(deps.createExpenseWithSplits).not.toHaveBeenCalled()
  })

  it('the daily cap is mapped to plain words and nothing runs', async () => {
    const { rpc, ctx, deps } = setup({ rpc: { begin: vi.fn(async () => { throw new ChatRpcError({ message: 'x', code: 'P0001', hint: 'daily_cap' }) }) } })
    expect(await confirmAction(tap(), { rpc, ctx })).toEqual({ kind: 'blocked', message: DAILY_CAP_MESSAGE })
    expect(DAILY_CAP_MESSAGE).toBe("You've confirmed a lot today — try again tomorrow.")
    expect(deps.toggleTodo).not.toHaveBeenCalled()
  })

  it('actions switched off is a final plain refusal and nothing runs', async () => {
    const { rpc, ctx, deps } = setup({ rpc: { begin: vi.fn(async () => { throw new ChatRpcError({ message: 'The assistant is not allowed', code: 'P0001', hint: 'actions_off' }) }) } })
    const out = await confirmAction(tap(), { rpc, ctx })
    expect(out).toEqual({ kind: 'actions_off', message: "Changes from the assistant are switched off for this trip, so this wasn't done." })
    expect(ACTIONS_OFF_MESSAGE).toBe((out as { message: string }).message)
    expect(deps.toggleTodo).not.toHaveBeenCalled()
  })

  it('every hint the chat RPCs raise has its own plain message', () => {
    const generic = 'Something went wrong. Please try again.'
    for (const hint of ['actions_off', 'daily_cap', 'not_found', 'forbidden', 'auth', 'not_started', 'bad_input', 'immutable', 'invalid', 'admin_only']) {
      const text = describeChatRpcError({ message: 'raw database text', code: 'P0001', hint })
      expect(text, hint).not.toBe(generic)
      expect(text, hint).not.toMatch(/raw database text|P0001/)
    }
    expect(describeChatRpcError({ message: 'x', hint: 'something_new' })).toBe(generic)
  })

  it('an actions-off card has no approve path but stays dismissible', () => {
    expect(cardPhase(tap(), { running: false, stale: null, actionsOff: true }, Date.now())).toBe('actions_off')
    expect(cardPhase(tap({ status: 'done' }), { running: false, stale: null, actionsOff: true }, Date.now())).toBe('done')
  })

  it('someone else\'s action id looks like not found', async () => {
    const { rpc, ctx } = setup({ rpc: { begin: vi.fn(async () => { throw new ChatRpcError({ message: 'x', code: 'P0002', hint: 'not_found' }) }) } })
    const out = await confirmAction(tap(), { rpc, ctx })
    expect(out).toEqual({ kind: 'blocked', message: "That suggestion isn't available any more." })
  })

  it('a write error is mapped (frozen hint) and recorded as failed', async () => {
    const { rpc, ctx, fns } = setup({ toggleTodo: vi.fn(async () => { throw { message: 'frozen', code: 'P0001', hint: 'frozen' } }) as never })
    const out = await confirmAction(tap(), { rpc, ctx })
    expect(out).toMatchObject({ kind: 'failed', message: FROZEN_WRITE_MESSAGE })
    expect(fns.finish).toHaveBeenCalledWith('act-tick_todo', false, null, FROZEN_WRITE_MESSAGE)
  })

  it('raw database wording is never shown', () => {
    expect(failureMessage({ message: 'new row violates row-level security policy for table "x"' })).toBe(GENERIC_FAILURE)
    expect(failureMessage(new Error('Someone else just took this one, or it is no longer up for grabs.'))).toMatch(/Someone else/)
    expect(failureMessage({})).toBe(GENERIC_FAILURE)
  })

  it('if only the bookkeeping fails after the write, the card still says done', async () => {
    const { rpc, ctx } = setup({ rpc: { finish: vi.fn(async () => { throw new Error('offline') }) } })
    expect((await confirmAction(tap(), { rpc, ctx })).kind).toBe('done')
  })

  it('malformed params and link cards never run', async () => {
    const { rpc, ctx, fns } = setup()
    expect((await confirmAction(envelope('add_todo', todoParams({ title: '' })), { rpc, ctx })).kind).toBe('invalid')
    expect((await confirmAction(envelope('open_screen', { open_param: 'settle' }), { rpc, ctx })).kind).toBe('invalid')
    expect(fns.begin).not.toHaveBeenCalled()
    void SAM
  })

  it('dismiss is the only thing Not now does', async () => {
    const { rpc, fns } = setup()
    const out = await dismissAction(tap(), rpc)
    expect(out.ok).toBe(true)
    expect(fns.begin).not.toHaveBeenCalled()
  })
})

const tickedLive = () => liveFixture({ actions: [{ id: 'a1', title: 'Book the ferry', completed_at: '2026-11-17T11:00:00Z', assigned_to: ME, trip_action_completions: [] }] as never })

describe('undo window', () => {
  const now = Date.parse('2026-11-17T12:00:00Z')
  const done = (minsAgo: number, over: Partial<ChatActionEnvelope> = {}) => tap({ status: 'done', finished_at: new Date(now - minsAgo * 60_000).toISOString(), ...over })
  it('is offered for 10 minutes on self-only (tap) actions that can be reversed', () => {
    expect(canUndo(done(2), now)).toBe(true)
    expect(canUndo(done(11), now)).toBe(false)
    expect(UNDO_WINDOW_MS).toBe(600_000)
    expect(canUndo(done(2, { requires: 'review' }), now)).toBe(false)
    expect(canUndo(done(2, { status: 'failed' }), now)).toBe(false)
    expect(canUndo(envelope('add_expense', expenseParams(), { status: 'done', requires: 'tap', finished_at: new Date(now).toISOString() }), now)).toBe(false) // money: no undo
  })
  it('runs the inverse through the same shared function', async () => {
    const { ctx, deps } = setup({ live: tickedLive() })
    const out = await undoAction(done(1, { result: { undo: { fn: 'toggleTodo', args: ['t1', { actionId: 'a1', isGroupAction: false, userId: ME, done: false }], label: 'x' } } }), ctx)
    expect(out).toEqual({ ok: true })
    expect(deps.toggleTodo).toHaveBeenCalledWith('t1', { actionId: 'a1', isGroupAction: false, userId: ME, done: false })
  })
  it('reports a failed undo in plain words', async () => {
    const { ctx } = setup({ live: tickedLive(), toggleTodo: vi.fn(async () => { throw new Error("You don't have permission to update this action, or it no longer exists.") }) as never })
    const out = await undoAction(done(1, { result: { undo: { fn: 'toggleTodo', args: ['t1', {}], label: 'x' } } }), ctx)
    expect(out).toMatchObject({ ok: false, message: expect.stringMatching(/permission/) })
  })
})

describe('card phase', () => {
  const now = Date.parse('2026-11-17T12:00:00Z')
  const idle = { running: false, stale: null }
  it('maps stored status and local state', () => {
    expect(cardPhase(tap(), idle, now)).toBe('proposed')
    expect(cardPhase(tap(), { running: true, stale: null }, now)).toBe('running')
    expect(cardPhase(tap(), { running: false, stale: 'x' }, now)).toBe('stale')
    expect(cardPhase(tap({ status: 'done' }), idle, now)).toBe('done')
    expect(cardPhase(tap({ status: 'failed' }), idle, now)).toBe('failed')
    expect(cardPhase(tap({ status: 'dismissed' }), idle, now)).toBe('dismissed')
    expect(cardPhase(tap({ status: 'expired' }), idle, now)).toBe('expired')
    expect(cardPhase(tap({ status: 'edited_elsewhere' }), idle, now)).toBe('edited')
  })
  it('a proposal past its expiry reads as expired even before the server says so', () => {
    expect(cardPhase(tap({ expires_at: '2026-11-17T11:00:00Z' }), idle, now)).toBe('expired')
  })
  it('executing: elsewhere at first, "did this go through?" after two minutes', () => {
    const started = (msAgo: number) => tap({ status: 'executing', started_at: new Date(now - msAgo).toISOString() })
    expect(cardPhase(started(10_000), idle, now)).toBe('working_elsewhere')
    expect(cardPhase(started(STUCK_AFTER_MS + 1000), idle, now)).toBe('stuck')
  })
})

describe('review fixes', () => {
  const now = Date.parse('2026-11-17T12:00:00Z')
  it('a late refetch never overwrites a finished card', async () => {
    const { mergeAction } = await import('./confirmFlow')
    const done = tap({ status: 'done', finished_at: '2026-11-17T11:59:00Z' })
    expect(mergeAction(done, tap({ status: 'executing' })).status).toBe('done')
    expect(mergeAction(done, tap({ status: 'proposed' })).status).toBe('done')
    expect(mergeAction(tap({ status: 'failed' }), tap({ status: 'proposed' })).status).toBe('failed')
    expect(mergeAction(tap({ status: 'dismissed' }), tap({ status: 'executing' })).status).toBe('dismissed')
    expect(mergeAction(tap({ status: 'executing' }), tap({ status: 'done' })).status).toBe('done')
    expect(mergeAction(undefined, tap()).status).toBe('proposed')
  })
  it('a blocked outcome is a visible phase, and a stale card wins over it', () => {
    expect(cardPhase(tap(), { running: false, stale: null, blocked: "You've confirmed a lot today" }, now)).toBe('blocked')
    expect(cardPhase(tap(), { running: false, stale: 'x', blocked: 'y' }, now)).toBe('stale')
    expect(cardPhase(tap({ status: 'done' }), { running: false, stale: null, blocked: 'y' }, now)).toBe('done')
  })
  it('an executing action with no started_at still becomes stuck, from created_at', () => {
    expect(cardPhase(tap({ status: 'executing', started_at: null, created_at: '2026-11-17T10:00:00Z' }), { running: false, stale: null }, now)).toBe('stuck')
  })
  it('stuck wording points at where to look', async () => {
    const { stuckMessage } = await import('./confirmFlow')
    expect(stuckMessage('add_expense')).toBe("This didn't finish — check the Money tab before trying again.")
  })
  it('undo is not offered when the server row says it was undone, or when the row changed', () => {
    const doneTick = tap({ status: 'done', finished_at: new Date(now - 60_000).toISOString() })
    expect(canUndo({ ...doneTick, result: { undone_at: '2026-11-17T11:59:30Z' } }, now)).toBe(false)
    expect(canUndo(doneTick, now, liveFixture())).toBe(false) // a1 is not ticked any more
    expect(canUndo(doneTick, now, liveFixture({ actions: [{ id: 'a1', title: 'x', completed_at: 'y', assigned_to: ME, trip_action_completions: [] }] as never }))).toBe(true)
  })
  it('undo re-checks live data after a refresh and writes nothing when it changed', async () => {
    const { ctx, deps } = setup()
    const a = tap({ status: 'done', result: { undo: { fn: 'toggleTodo', args: ['t1', {}], label: 'x' } } })
    const out = await undoAction(a, ctx)
    expect(out).toMatchObject({ ok: false, message: expect.stringMatching(/changed/) })
    expect(deps.toggleTodo).not.toHaveBeenCalled()
  })
  it('a failed write is reported to the error reporter', async () => {
    const reporter = await import('../../../lib/reportError')
    const spy = vi.spyOn(reporter, 'reportError').mockImplementation(() => undefined)
    const { rpc, ctx } = setup({ toggleTodo: vi.fn(async () => { throw new Error('boom') }) as never })
    await confirmAction(tap(), { rpc, ctx })
    expect(spy).toHaveBeenCalledWith(expect.any(Error), 'chat:tick_todo')
    spy.mockRestore()
  })
})
