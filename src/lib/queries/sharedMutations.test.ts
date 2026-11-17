/**
 * The plain mutation functions (toggleTodo, claimTodo, suggestOption, createExpenseWithSplits, ...) make exactly
 * the requests the hooks make, because the hooks call them. Each case runs the hook's mutationFn and the plain
 * function against a recording Supabase mock and compares the recorded requests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: unknown) => opts,
  useQuery: (opts: unknown) => opts,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))
vi.mock('./makeOptimisticMutation', () => ({ useOptimisticMutation: (opts: unknown) => opts }))
vi.mock('./useTrip', () => ({ useParticipants: vi.fn(), useTrip: vi.fn() }))
vi.mock('../../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))
vi.mock('../../features/organizer/lib/activity', () => ({ useTripActivityLog: () => vi.fn() }))
vi.mock('../fx/resolveExpenseFxFields', async (orig) => ({
  ...(await orig<typeof import('../fx/resolveExpenseFxFields')>()),
  resolveExpenseFxFields: vi.fn(async () => ({ fx_rate: 0.8, fx_rate_date: '2026-11-01', base_currency_amount: 32, rate_source: 'test' })),
}))

type Call = { path: string; args: unknown[] }
let calls: Call[] = []
let rows: unknown[] = [{ id: 'row-1' }]
let single: unknown = { id: 'row-1', description: 'Dinner' }
let failAt: string | null = null
let rpcError: { message: string; code?: string; hint?: string } | null = null
let rpcData: unknown = null

function chain(table: string) {
  const path = [`from(${table})`]
  const c: Record<string, unknown> = {}
  const record = (name: string) => (...args: unknown[]) => {
    calls.push({ path: `${path.join('.')}.${name}`, args })
    path.push(name)
    return c
  }
  for (const m of ['insert', 'update', 'delete', 'upsert', 'eq', 'is', 'in', 'order']) c[m] = record(m)
  c.select = (...args: unknown[]) => {
    calls.push({ path: `${path.join('.')}.select`, args })
    path.push('select')
    return c
  }
  c.single = () => {
    calls.push({ path: `${path.join('.')}.single`, args: [] })
    return Promise.resolve({ data: single, error: failAt === `${table}.insert` ? { message: 'boom' } : null })
  }
  c.then = (res: (v: unknown) => unknown) => {
    const isInsertFail = failAt === `${table}.${path[1] ?? ''}`
    return Promise.resolve({ data: rows, error: isInsertFail ? { message: 'boom' } : null }).then(res)
  }
  return c
}

vi.mock('../supabase', () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: (fn: string, args: unknown) => {
      calls.push({ path: `rpc(${fn})`, args: [args] })
      return Promise.resolve({ data: rpcData, error: rpcError })
    },
  },
}))

import { useToggleActionDone, toggleTodo, useClaimAction, claimTodo, useCreateAction, createTodo } from './useActions'
import { useToggleChecklistItem, toggleChecklistItem, useClaimChecklistItem, claimChecklistItem, useCreateChecklistItem, createChecklistItem } from './useChecklists'
import { useSuggestOption, suggestOption, invalidateAfterSuggestOption } from './useSuggestions'
import { useCreateOption, addOptionToQuestion, answerQuestion, invalidateAfterAnswer } from './usePlanning'
import { useCreateExpense, createExpenseWithSplits, insertExpenseWithSplits, invalidateAfterCreateExpense } from './useExpenses'
import { useAddToPlanSave, createQuestionWithOptions } from '../../features/plan/lib/useAddToPlanSave'
import { emptyQuestion } from '../../features/plan/lib/addFlow'
import { emptyWizardDraft } from '../../features/expenses/editor/wizardState'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hookFn = (hook: any, ...a: unknown[]) => hook('trip-1', ...a).mutationFn

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-17T12:00:00Z'))
  calls = []
  rows = [{ id: 'row-1' }]
  single = { id: 'row-1', description: 'Dinner' }
  failAt = null
  rpcError = null
  rpcData = null
})

/** Run `viaHook` then `viaFn` and expect the identical recorded requests. */
async function sameRequests(viaHook: () => Promise<unknown>, viaFn: () => Promise<unknown>) {
  calls = []
  await viaHook()
  const hookCalls = calls
  calls = []
  await viaFn()
  expect(calls).toEqual(hookCalls)
  expect(calls.length).toBeGreaterThan(0)
}

afterEach(() => vi.useRealTimers())

describe('to-dos', () => {
  const vars = { actionId: 'a1', isGroupAction: false, userId: 'u1', done: true }
  it('toggleTodo makes the hook\'s requests (individual, group, anyone)', async () => {
    rpcError = { message: 'function claim_todo does not exist', code: 'PGRST202' }
    for (const v of [vars, { ...vars, isGroupAction: true }, { ...vars, isGroupAction: true, done: false }, { ...vars, anyone: true }]) {
      await sameRequests(() => hookFn(useToggleActionDone)(v), () => toggleTodo('trip-1', v))
    }
  })
  it('toggleTodo returns the opposite toggle as an undo descriptor', async () => {
    const { undo } = await toggleTodo('trip-1', vars)
    expect(undo).toMatchObject({ fn: 'toggleTodo', args: ['trip-1', { ...vars, done: false }] })
  })
  it('toggleTodo throws the same plain error when nothing matched', async () => {
    rows = []
    await expect(toggleTodo('trip-1', vars)).rejects.toThrow(/permission to update/)
  })
  it('claimTodo uses the RPC and gives the claim back as undo', async () => {
    await sameRequests(() => hookFn(useClaimAction)({ id: 'a1', userId: 'u1', claim: true }), () => claimTodo({ id: 'a1', userId: 'u1', claim: true }))
    expect(calls[0]).toEqual({ path: 'rpc(claim_todo)', args: [{ p_source: 'action', p_id: 'a1', p_action: 'claim' }] })
    expect((await claimTodo({ id: 'a1', userId: 'u1', claim: true })).undo.args[0].claim).toBe(false)
  })
  it('claimTodo falls back to the direct update and reports a lost claim in words', async () => {
    rpcError = { message: 'x', code: 'PGRST202' }
    await sameRequests(() => hookFn(useClaimAction)({ id: 'a1', userId: 'u1', claim: false }), () => claimTodo({ id: 'a1', userId: 'u1', claim: false }))
    rows = []
    await expect(claimTodo({ id: 'a1', userId: 'u1', claim: true })).rejects.toThrow('Someone else just took this one')
  })
  it('claim_todo rule errors carry the server wording', async () => {
    rpcError = { message: 'Already done', code: 'P0001' }
    await expect(claimTodo({ id: 'a1', userId: 'u1', claim: true })).rejects.toThrow('Already done')
  })
  it('createTodo inserts the same row and returns it', async () => {
    const input = { title: 'Book ferry', created_by: 'u1', assigned_to: null }
    await sameRequests(() => hookFn(useCreateAction)(input), () => createTodo('trip-1', input))
    expect(await createTodo('trip-1', input)).toEqual(single)
    expect(calls.find((c) => c.path.endsWith('.insert'))?.args[0]).toEqual({ trip_id: 'trip-1', ...input })
  })
})

describe('checklist to-dos', () => {
  it('toggleChecklistItem / claimChecklistItem / createChecklistItem match the hooks', async () => {
    rpcError = { message: 'x', code: 'PGRST202' }
    await sameRequests(() => hookFn(useToggleChecklistItem)({ id: 'c1', done: true, doneBy: 'u1' }), () => toggleChecklistItem({ id: 'c1', done: true, doneBy: 'u1' }))
    await sameRequests(() => hookFn(useClaimChecklistItem)({ id: 'c1', userId: 'u1', claim: true }), () => claimChecklistItem({ id: 'c1', userId: 'u1', claim: true }))
    const input = { title: 'Speaker', created_by: 'u1' }
    await sameRequests(() => hookFn(useCreateChecklistItem)(input), () => createChecklistItem('trip-1', input))
    expect((await toggleChecklistItem({ id: 'c1', done: true, doneBy: 'u1' })).undo.args[0]).toEqual({ id: 'c1', done: false, doneBy: 'u1' })
    rows = []
    await expect(toggleChecklistItem({ id: 'c1', done: true, doneBy: 'u1' })).rejects.toThrow("can't tick this one off")
  })
})

describe('suggestions and options', () => {
  it('suggestOption sends the hook\'s RPC for an option and for an idea', async () => {
    await sameRequests(() => hookFn(useSuggestOption)({ sectionId: 's1', title: ' Pizza ', link: ' https://a.b ', note: 'n' }), () => suggestOption('trip-1', { sectionId: 's1', title: ' Pizza ', link: ' https://a.b ', note: 'n' }))
    expect(calls[0].args[0]).toEqual({ p_section_id: 's1', p_title: 'Pizza', p_link: 'https://a.b', p_note: 'n' })
    await sameRequests(() => hookFn(useSuggestOption)({ sectionId: null, idea: true, title: 'Kayak' }), () => suggestOption('trip-1', { sectionId: null, idea: true, title: 'Kayak' }))
    expect(calls[0].args[0]).toEqual({ p_section_id: null, p_title: 'Kayak', p_idea: true, p_trip_id: 'trip-1' })
  })
  it('suggestOption throws the plain messages', async () => {
    rpcError = { message: 'function suggest_option does not exist', code: 'PGRST202' }
    await expect(suggestOption('trip-1', { title: 'x' })).rejects.toThrow('Suggestions are not switched on for this trip yet.')
    rpcError = { message: 'This question is closed', code: 'P0001', hint: 'closed' }
    await expect(suggestOption('trip-1', { sectionId: 's1', title: 'x' })).rejects.toMatchObject({ message: 'This question is closed', hint: 'closed' })
  })
  it('suggestOption invalidates through the helper', () => {
    const qc = { invalidateQueries: vi.fn() }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    invalidateAfterSuggestOption(qc as any, 'trip-1')
    expect(qc.invalidateQueries.mock.calls.length).toBeGreaterThanOrEqual(8)
  })
  it('addOptionToQuestion matches useCreateOption', async () => {
    const input = { section_id: 's1', title: 'Hotel A', created_by: 'u1' }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sameRequests(() => hookFn(useCreateOption)(input), () => addOptionToQuestion(input as any))
  })
  it('createQuestionWithOptions inserts the question then its options, and removes an empty question on failure', async () => {
    const hook = useAddToPlanSave('trip-1', 'u1') as unknown as { question: { mutationFn: (v: unknown) => Promise<unknown> } }
    const values = { ...emptyQuestion('GBP'), title: 'Where to eat?', optionsText: 'A\nB' }
    await sameRequests(() => hook.question.mutationFn(values), () => createQuestionWithOptions('trip-1', values))
    expect(calls.map((c) => c.path)).toEqual(expect.arrayContaining(['from(planning_sections).insert', 'from(options).insert']))
    calls = []
    failAt = 'options.insert'
    await expect(createQuestionWithOptions('trip-1', values)).rejects.toBeTruthy()
    expect(calls.some((c) => c.path.startsWith('from(planning_sections).delete'))).toBe(true)
  })
})

describe('answers', () => {
  const section = {
    id: 's1',
    status: 'open',
    voting_method: 'single',
    options: [
      { id: 'o1', title: 'A', selections: [] },
      { id: 'o2', title: 'B', selections: [] },
    ],
  }
  const gate = { state: 'open' as const, canAnswer: true, reason: null, disabledLabel: null }
  it('answerQuestion writes the plan and returns my previous answer for undo', async () => {
    const votes = [{ id: 'v1', option_id: 'o1', user_id: 'u1', rank: null }]
    const out = await answerQuestion({ section, userId: 'u1', gate, votes, passes: [], action: { type: 'pick', optionId: 'o2' } })
    expect(out.plan.sectionId).toBe('s1')
    expect(out.undo?.previous).toMatchObject({ sectionId: 's1', votes: [{ optionId: 'o1', rank: null }], pass: null })
    expect(calls.some((c) => c.path === 'from(option_votes).upsert')).toBe(true)
  })
  it('answerQuestion refuses a closed question with the plan\'s reason and writes nothing', async () => {
    const closed = { state: 'decided' as const, canAnswer: false, reason: 'This question is decided.', disabledLabel: 'Answers closed' }
    await expect(answerQuestion({ section, userId: 'u1', gate: closed, votes: [], passes: [], action: { type: 'pick', optionId: 'o1' } })).rejects.toThrow('This question is decided.')
    expect(calls).toEqual([])
  })
  it('invalidateAfterAnswer refreshes votes, questions, passes and to-dos', () => {
    const qc = { invalidateQueries: vi.fn() }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    invalidateAfterAnswer(qc as any, 'trip-1')
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(4)
  })
})

describe('expenses', () => {
  const draft = {
    ...emptyWizardDraft({ today: '2026-11-17', baseCurrency: 'GBP', currentUserId: 'u1', allParticipantIds: ['u1', 'u2'] }),
    description: ' Dinner ',
    currency: 'EUR',
    paidBy: 'u1',
    splitMode: 'equal' as const,
  }
  it('createExpenseWithSplits inserts the expense then the splits with FX fields, like the wizard', async () => {
    const out = await createExpenseWithSplits('trip-1', { draft, amountMajor: 40, receiptUrl: null, baseCurrency: 'GBP' })
    expect(out).toEqual(single)
    const insert = calls.find((c) => c.path === 'from(expenses).insert')!.args[0] as Record<string, unknown>
    expect(insert).toMatchObject({ trip_id: 'trip-1', description: 'Dinner', amount: 40, currency: 'EUR', paid_by: 'u1', participant_ids: ['u1', 'u2'], fx_rate: 0.8, base_currency_amount: 32, rate_source: 'test' })
    const splits = calls.find((c) => c.path === 'from(expense_splits).insert')!.args[0] as Array<Record<string, unknown>>
    expect(splits.map((s) => [s.expense_id, s.user_id, s.amount, s.split_type, s.base_currency_amount])).toEqual([
      ['row-1', 'u1', 20, 'equal', 16],
      ['row-1', 'u2', 20, 'equal', 16],
    ])
  })
  it('the hook writes the same requests as insertExpenseWithSplits', async () => {
    const payload = { expense: { description: 'x', amount: 5, currency: 'GBP', paid_by: 'u1' }, splits: [{ user_id: 'u1', amount: 5, split_type: 'equal' as const }] }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sameRequests(() => hookFn(useCreateExpense)(payload), () => insertExpenseWithSplits('trip-1', payload as any))
  })
  it('rolls the expense back and throws the splits error', async () => {
    failAt = 'expense_splits.insert'
    const payload = { expense: { description: 'x', amount: 5, currency: 'GBP', paid_by: 'u1' }, splits: [{ user_id: 'u1', amount: 5, split_type: 'equal' as const }] }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(insertExpenseWithSplits('trip-1', payload as any)).rejects.toMatchObject({ message: 'boom' })
    expect(calls.some((c) => c.path === 'from(expenses).delete')).toBe(true)
  })
  it('invalidateAfterCreateExpense refreshes the expenses', () => {
    const qc = { invalidateQueries: vi.fn() }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    invalidateAfterCreateExpense(qc as any, 'trip-1')
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(1)
  })
})
