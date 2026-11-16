/**
 * The answer executor must never delete before the replacement is stored, so a
 * failing second step leaves a consistent state (B1/B2/B3). Uses a recording
 * fake client; the ordering rule itself is also unit-tested in answerModel.test.ts.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../supabase', () => ({ supabase: { from: () => { throw new Error('real client used') } } }))

import { executeAnswerPlan, type AnswerWriteClient } from './usePlanning'
import { answerGate, planAnswer, type AnswerAction, type AnswerPlan, type ModelPass, type ModelSection, type ModelVote } from '../../features/decisions/lib/answerModel'
import { legacySkiRental, option, rankedStay, section, vote } from '../../features/decisions/lib/answerFixtures'

const viewer = { userId: 'sam', tripFinished: false, out: false }

function plan(s: ModelSection, action: AnswerAction, votes: ModelVote[] = [], passes: ModelPass[] = []): AnswerPlan {
  const r = planAnswer({ section: s, userId: 'sam', gate: answerGate(s, viewer), votes, passes }, action)
  if (!r.ok) throw new Error(r.reason)
  return r.plan
}

/** Fake supabase: records `table.op` per executed statement; `failOn` makes one fail. */
function fakeClient(failOn?: string) {
  const log: string[] = []
  const from = (table: string) => {
    let op = ''
    const finish = () => {
      const key = `${table}.${op}`
      log.push(key)
      return Promise.resolve(key === failOn ? { data: null, error: { message: `boom ${key}` } } : { data: [{ id: 'row' }], error: null })
    }
    const c: Record<string, unknown> = {}
    for (const name of ['delete', 'upsert', 'insert', 'update']) c[name] = () => { op = name; return c }
    c.eq = () => c
    c.in = () => c
    c.select = () => finish()
    // question_passes writes are awaited without .select()
    c.then = (res: (v: unknown) => unknown) => finish().then(res)
    return c
  }
  return { client: { from } as unknown as AnswerWriteClient, log }
}

describe('executeAnswerPlan ordering', () => {
  const single = section('s-one', { voting_method: 'single', options: [option('a', 'A'), option('b', 'B')] })

  it('choose-one swap: the new vote is stored before the old one is deleted', async () => {
    const { client, log } = fakeClient()
    await executeAnswerPlan(plan(single, { type: 'pick', optionId: 'b' }, [vote('v1', 'a', 'sam')]), client)
    expect(log).toEqual(['option_votes.upsert', 'option_votes.delete'])
  })

  it('choose-one swap: if the upsert fails nothing is deleted', async () => {
    const { client, log } = fakeClient('option_votes.upsert')
    await expect(executeAnswerPlan(plan(single, { type: 'pick', optionId: 'b' }, [vote('v1', 'a', 'sam')]), client)).rejects.toThrow(/boom/)
    expect(log).toEqual(['option_votes.upsert'])
  })

  it('choose-one swap: if the delete fails the new pick is already stored', async () => {
    const { client, log } = fakeClient('option_votes.delete')
    await expect(executeAnswerPlan(plan(single, { type: 'pick', optionId: 'b' }, [vote('v1', 'a', 'sam')]), client)).rejects.toThrow(/boom/)
    expect(log).toEqual(['option_votes.upsert', 'option_votes.delete'])
  })

  it('pass: the pass is stored before any answer is removed; a failing pass insert removes nothing', async () => {
    const votes = [vote('v1', 'o-granvia', 'sam', 1)]
    const ok = fakeClient()
    await executeAnswerPlan(plan(rankedStay, { type: 'pass' }, votes), ok.client)
    expect(ok.log).toEqual(['question_passes.upsert', 'option_votes.delete'])

    const bad = fakeClient('question_passes.upsert')
    await expect(executeAnswerPlan(plan(rankedStay, { type: 'pass' }, votes), bad.client)).rejects.toThrow(/boom/)
    expect(bad.log).toEqual(['question_passes.upsert'])
  })

  it('own-choice pass over a stale-kind pass deletes only the pass first, then inserts, then drops picks', async () => {
    const { client, log } = fakeClient()
    const passes: ModelPass[] = [{ section_id: 's-ski', user_id: 'sam', kind: 'no_preference' }]
    await executeAnswerPlan(plan(legacySkiRental(), { type: 'pass' }, [], passes), client)
    expect(log).toEqual(['question_passes.delete', 'question_passes.upsert', 'selections.delete'])
  })

  it('un-pass into a real answer: the answer is written before the pass is deleted', async () => {
    const passes: ModelPass[] = [{ section_id: 's-stay', user_id: 'sam', kind: 'no_preference' }]
    const { client, log } = fakeClient()
    await executeAnswerPlan(plan(rankedStay, { type: 'pick', optionId: 'o-granvia' }, [], passes), client)
    expect(log).toEqual(['option_votes.upsert', 'question_passes.delete'])

    const bad = fakeClient('option_votes.upsert')
    await expect(executeAnswerPlan(plan(rankedStay, { type: 'pick', optionId: 'o-granvia' }, [], passes), bad.client)).rejects.toThrow(/boom/)
    expect(bad.log).toEqual(['option_votes.upsert'])
  })

  it('ranked removal deletes first, then renumbers (a failure leaves a gap, not duplicate ranks)', async () => {
    const votes = [vote('v1', 'o-airbnb', 'sam', 1), vote('v2', 'o-granvia', 'sam', 2)]
    const { client, log } = fakeClient()
    await executeAnswerPlan(plan(rankedStay, { type: 'pick', optionId: 'o-airbnb' }, votes), client)
    expect(log).toEqual(['option_votes.delete', 'option_votes.upsert'])
  })

  it('two queued taps executed in order end on the last pick (serialised writes)', async () => {
    // Tap A then B on a choose-one question. Plan 2 was computed from the optimistic state
    // (A's vote is `optimistic-`), so it deletes A by option id AFTER storing B.
    const tapA = plan(single, { type: 'pick', optionId: 'a' })
    const tapB = plan(single, { type: 'pick', optionId: 'b' }, [vote('optimistic-a-sam', 'a', 'sam')])
    const { client, log } = fakeClient()
    for (const p of [tapA, tapB]) await executeAnswerPlan(p, client) // what the scope queue does
    expect(log).toEqual(['option_votes.upsert', 'option_votes.upsert', 'option_votes.delete'])
  })
})
