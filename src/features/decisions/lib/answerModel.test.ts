import { describe, expect, it } from 'vitest'
import {
  answerGate,
  answerMode,
  applyPlanToPasses,
  applyPlanToSelections,
  applyPlanToVotes,
  buildAnswerControlModel,
  isDateQuestion,
  orderedSteps,
  ownRowsToItems,
  ownTotals,
  planAnswer,
  recomputeOwnRow,
  type AnswerAction,
  type AnswerPlan,
  type ModelPass,
  type ModelSection,
  type ModelViewer,
  type ModelVote,
} from './answerModel'
import { buildQuestionCardModel } from './questionCardModel'
import { describeAnswerError, formatDateSpan, ordinal } from './answerCopy'
import { legacySkiRental, option, rankedStay, section, tripDates, vote } from './answerFixtures'

const me: ModelViewer = { userId: 'sam', tripFinished: false, out: false }
const OPEN = answerGate(rankedStay, me)

function control(s: ModelSection, votes: ModelVote[] = [], passes: ModelPass[] | 'unavailable' = [], viewer: ModelViewer = me) {
  return buildAnswerControlModel({ section: s, viewer, votes, passes: passes === 'unavailable' ? undefined : passes, defaultDates: { start: '2027-02-06', end: '2027-02-11' }, fallbackCurrency: 'EUR', now: Date.parse('2026-11-16T12:00:00Z') })
}

function plan(s: ModelSection, action: AnswerAction, votes: ModelVote[] = [], passes: ModelPass[] | undefined = [], viewer: ModelViewer = me): AnswerPlan {
  const r = planAnswer({ section: s, userId: viewer.userId as string, gate: answerGate(s, viewer), votes, passes }, action)
  if (!r.ok) throw new Error(`refused: ${r.reason}`)
  return r.plan
}

describe('shape detection', () => {
  it('maps voting_method and decision_shape to a mode', () => {
    expect(answerMode(rankedStay)).toBe('ranked')
    expect(answerMode(tripDates)).toBe('single')
    expect(answerMode({ metadata: {}, voting_method: 'approval' })).toBe('any')
    expect(answerMode(legacySkiRental())).toBe('own')
  })
  it('recognises date questions (date_range on options), never own choices', () => {
    expect(isDateQuestion(tripDates)).toBe(true)
    expect(isDateQuestion(rankedStay)).toBe(false)
    expect(isDateQuestion(legacySkiRental())).toBe(false)
  })
})

describe('answerGate', () => {
  it('open for a participant', () => {
    expect(OPEN).toMatchObject({ state: 'open', canAnswer: true, reason: null, disabledLabel: null })
  })
  it('decided beats finished beats out; decided says "Answers closed"', () => {
    const decided = { ...rankedStay, status: 'completed' }
    expect(answerGate(decided, { userId: 'sam', tripFinished: true, out: true }).state).toBe('decided')
    expect(answerGate(decided, me).disabledLabel).toBe('Answers closed')
    expect(answerGate(rankedStay, { userId: 'sam', tripFinished: true, out: true }).state).toBe('finished')
    expect(answerGate(rankedStay, { userId: 'sam', tripFinished: false, out: true })).toMatchObject({ state: 'out', canAnswer: false })
    expect(answerGate(rankedStay, { userId: null, tripFinished: false }).state).toBe('signed_out')
  })
  it('no live options', () => {
    const cancelled = { ...rankedStay, options: rankedStay.options.map((o) => ({ ...o, status: 'cancelled' })) }
    expect(answerGate(cancelled, me).state).toBe('no_options')
  })
})

describe('read model: ranked group choice', () => {
  const votes = [vote('v1', 'o-granvia', 'sam', 1), vote('v2', 'o-airbnb', 'sam', 2), vote('v3', 'o-airbnb', 'tim', 1)]
  it('shows my ranks as ordinals and a ranking summary', () => {
    const m = control(rankedStay, votes)
    expect(m.mode).toBe('ranked')
    expect(m.instruction).toBe('Rank your top choices')
    expect(m.rows.map((r) => [r.title, r.rank, r.marker])).toEqual([
      ['Osaka Airbnb (17–21 Aug)', 2, '2nd'],
      ['Hotel Granvia', 1, '1st'],
      ['Ryokan Kurashiki', null, null],
    ])
    expect(m.myState).toBe('answered')
    expect(m.mySummary).toBe('Your ranking: 1st Hotel Granvia, 2nd Osaka Airbnb (17–21 Aug)')
    expect(m.canClear).toBe(true)
  })
  it('legacy ranked votes saved without a rank are shown in creation order', () => {
    const m = control(rankedStay, [vote('a', 'o-ryokan', 'sam'), vote('b', 'o-granvia', 'sam')])
    expect(m.rows.filter((r) => r.selected).map((r) => r.rank).sort()).toEqual([1, 2])
  })
  it('visible results lead with the Borda leader', () => {
    expect(control(rankedStay, [...votes, vote('v4', 'o-airbnb', 'amy', 1)]).results.leaderLabel).toBe('Leading: Osaka Airbnb (17–21 Aug)')
    // sam's 1st/2nd and tim's 1st tie on Borda: say so rather than pick one
    expect(control(rankedStay, votes).results.leaderLabel).toBe('Tied: Osaka Airbnb (17–21 Aug), Hotel Granvia')
  })
})

describe('read model: results visibility (stored setting)', () => {
  it('hidden while open when hide_votes_until_close is true, with the explanation and no counts', () => {
    const hidden = { ...tripDates, hide_votes_until_close: true }
    const m = control(hidden, [vote('v1', 'd-aug1', 'tim')])
    expect(m.results).toMatchObject({ visible: false, hiddenNote: 'Results show when it’s decided.', leaderLabel: null })
    expect(m.rows.every((r) => r.count === null && r.voterIds.length === 0)).toBe(true)
  })
  it('visible when the setting is off; counts and voters shown', () => {
    const m = control(tripDates, [vote('v1', 'd-aug1', 'tim'), vote('v2', 'd-aug1', 'amy'), vote('v3', 'd-aug2', 'sam')])
    expect(m.results.leaderLabel).toBe('Leading: 17–21 Aug (2)')
    expect(m.rows[0]).toMatchObject({ count: 2, countLabel: '2 people', leading: true })
  })
  it('a tie says so; a decided question shows counts but no leader line', () => {
    const tie = control(tripDates, [vote('v1', 'd-aug1', 'tim'), vote('v2', 'd-aug2', 'amy')])
    expect(tie.results.leaderLabel).toBe('Tied: 17–21 Aug, 24–28 Aug (1 each)')
    const decided = control({ ...tripDates, status: 'completed', hide_votes_until_close: true }, [vote('v1', 'd-aug1', 'tim')])
    expect(decided.results.visible).toBe(true)
    expect(decided.results.leaderLabel).toBeNull()
  })
  it('a past deadline reveals hidden results', () => {
    const m = control({ ...tripDates, hide_votes_until_close: true, vote_deadline: '2026-11-01T00:00:00Z' }, [])
    expect(m.results.visible).toBe(true)
  })
})

describe('read model: date question', () => {
  it('labels rows with the date span and keeps radio semantics', () => {
    const m = control(tripDates, [vote('v1', 'd-aug2', 'sam')])
    expect(m.isDates).toBe(true)
    expect(m.rows.map((r) => r.dateLabel)).toEqual(['17–21 Aug', '24–28 Aug', '28 Aug – 3 Sep'])
    expect(m.rows[1]).toMatchObject({ selected: true, marker: '✓ Your answer', indicator: 'radio' })
    expect(m.mySummary).toBe('Your answer: 24–28 Aug')
  })
})

describe('read model: pass button', () => {
  it('"No preference" on a group choice, "None for me" on an own choice', () => {
    expect(control(rankedStay).pass).toMatchObject({ kind: 'no_preference', label: 'No preference', visible: true, active: false })
    expect(control(legacySkiRental()).pass).toMatchObject({ kind: 'none_for_me', label: 'None for me', visible: true })
  })
  it('is hidden when the passes query is unavailable', () => {
    expect(control(rankedStay, [], 'unavailable').pass.visible).toBe(false)
  })
  it('a pass counts as answered and says so; a real answer beats a pass row', () => {
    const passes: ModelPass[] = [{ section_id: 's-stay', user_id: 'sam', kind: 'no_preference' }]
    const m = control(rankedStay, [], passes)
    expect(m).toMatchObject({ myState: 'passed', mySummary: 'You said: No preference' })
    expect(m.pass.active).toBe(true)
    const both = control(rankedStay, [vote('v1', 'o-granvia', 'sam', 1)], passes)
    expect(both.myState).toBe('answered')
    expect(both.pass.active).toBe(false)
  })
  it('is disabled with a reason when the question is decided', () => {
    const m = control({ ...rankedStay, status: 'completed' })
    expect(m.pass.disabled).toBe(true)
    expect(m.rows.every((r) => r.disabled)).toBe(true)
    expect(m.gate.reason).toMatch(/decided/)
  })
})

describe('read model: legacy own-choice order with quantities', () => {
  it('seeds my order from my selection and totals it (2 adult skis x 6 days at 28)', () => {
    const m = control(legacySkiRental())
    expect(m.mode).toBe('own')
    const skis = m.own!.rows[0]
    expect(skis).toMatchObject({ checked: true, variant: 'Adult', quantity: 2, startDate: '2027-02-06', endDate: '2027-02-11', needsDates: true, perDay: 28, total: 336 })
    expect(skis.variants).toEqual(['Adult', 'Kids'])
    expect(m.own!.totalLabel).toBe('€336')
    expect(m.myState).toBe('answered')
    expect(m.mySummary).toBe('Your answer: Skis + boots (Adult) × 2 · €336')
  })
  it('unpicked rows default to the person\'s travel dates; flat items need no dates', () => {
    const m = control(legacySkiRental())
    expect(m.own!.rows[1]).toMatchObject({ checked: false, quantity: 1, startDate: '2027-02-06', needsDates: false, flat: 12, total: 0 })
    expect(m.own!.rows[2].pricing).toBeNull()
  })
  it('recomputing a row follows variant, quantity and dates', () => {
    const row = control(legacySkiRental()).own!.rows[0]
    expect(recomputeOwnRow(row, { variant: 'Kids' }).total).toBe(216)
    expect(recomputeOwnRow(row, { quantity: 1 }).total).toBe(168)
    expect(recomputeOwnRow(row, { endDate: '2027-02-07' }).total).toBe(112)
    expect(recomputeOwnRow(row, { checked: false }).total).toBe(0)
    expect(recomputeOwnRow(row, { quantity: 0 }).quantity).toBe(1)
    const helmet = recomputeOwnRow(control(legacySkiRental()).own!.rows[1], { checked: true, quantity: 3 })
    expect(helmet.total).toBe(36)
    expect(ownTotals([row, helmet]).totalLabel).toBe('€372')
  })
  it('a person with nothing yet is unanswered; "None for me" makes them passed', () => {
    const zed: ModelViewer = { userId: 'zed', tripFinished: false }
    const none = control(legacySkiRental(), [], [], zed)
    expect(none.myState).toBe('unanswered')
    expect(none.mySummary).toBeNull()
    const passed = control(legacySkiRental(), [], [{ section_id: 's-ski', user_id: 'zed', kind: 'none_for_me' }], zed)
    expect(passed).toMatchObject({ myState: 'passed', mySummary: 'You said: None for me' })
  })
  it('own-choice counts come from selections when results are visible', () => {
    const m = control(legacySkiRental())
    expect(m.own!.rows[0]).toMatchObject({ count: 2, countLabel: '2 people' })
  })
})

describe('planAnswer: single (radio) group choice', () => {
  const s = tripDates
  it('adds a vote with no rank', () => {
    const p = plan(s, { type: 'pick', optionId: 'd-aug1' })
    expect(p).toMatchObject({ voteUpserts: [{ optionId: 'd-aug1', rank: null }], voteDeletes: [], pass: null, outcome: 'saved', toast: 'Answer saved', addedOptionId: 'd-aug1' })
  })
  it('replaces my previous choice (radio) and clears a pass', () => {
    const passes: ModelPass[] = [{ section_id: 's-dates', user_id: 'sam', kind: 'no_preference' }]
    const p = plan(s, { type: 'pick', optionId: 'd-aug2' }, [vote('v1', 'd-aug1', 'sam'), vote('x', 'd-aug1', 'tim')], passes)
    expect(p.voteDeletes).toEqual([{ id: 'v1', optionId: 'd-aug1' }])
    expect(p.voteUpserts).toEqual([{ optionId: 'd-aug2', rank: null }])
    expect(p.pass).toEqual({ op: 'clear' })
  })
  it('tapping my own choice withdraws it ("Answer removed")', () => {
    const p = plan(s, { type: 'pick', optionId: 'd-aug1' }, [vote('v1', 'd-aug1', 'sam')])
    expect(p).toMatchObject({ voteDeletes: [{ id: 'v1', optionId: 'd-aug1' }], voteUpserts: [], outcome: 'removed', toast: 'Answer removed' })
  })
  it('leftover selections on a group choice count as my answer and are replaced / removed with it', () => {
    const withSel = section('s-g', { options: [option('a', 'A', { selections: [{ id: 'sel-a', user_id: 'sam' }] }), option('b', 'B')] })
    const swap = plan(withSel, { type: 'pick', optionId: 'b' })
    expect(swap.selectionChanges).toEqual([{ optionId: 'a', selectionId: 'sel-a', metadata: null }])
    expect(swap.voteUpserts).toEqual([{ optionId: 'b', rank: null }])
    const off = plan(withSel, { type: 'pick', optionId: 'a' })
    expect(off.selectionChanges).toEqual([{ optionId: 'a', selectionId: 'sel-a', metadata: null }])
    expect(control(withSel).rows[0].selected).toBe(true)
  })
})

describe('planAnswer: any (checkbox) group choice', () => {
  const s = section('s-any', { voting_method: 'approval', options: [option('a', 'A'), option('b', 'B')] })
  it('stacks answers and toggles off individually', () => {
    expect(plan(s, { type: 'pick', optionId: 'b' }, [vote('v1', 'a', 'sam')])).toMatchObject({ voteDeletes: [], voteUpserts: [{ optionId: 'b', rank: null }] })
    expect(plan(s, { type: 'pick', optionId: 'a' }, [vote('v1', 'a', 'sam'), vote('v2', 'b', 'sam')])).toMatchObject({ voteDeletes: [{ id: 'v1', optionId: 'a' }], voteUpserts: [] })
  })
})

describe('planAnswer: ranked', () => {
  it('numbers answers 1, 2, 3 by tap order', () => {
    expect(plan(rankedStay, { type: 'pick', optionId: 'o-granvia' }).voteUpserts).toEqual([{ optionId: 'o-granvia', rank: 1 }])
    const second = plan(rankedStay, { type: 'pick', optionId: 'o-airbnb' }, [vote('v1', 'o-granvia', 'sam', 1)])
    expect(second.voteUpserts).toEqual([{ optionId: 'o-airbnb', rank: 2 }])
    const third = plan(rankedStay, { type: 'pick', optionId: 'o-ryokan' }, [vote('v1', 'o-granvia', 'sam', 1), vote('v2', 'o-airbnb', 'sam', 2)])
    expect(third.voteUpserts).toEqual([{ optionId: 'o-ryokan', rank: 3 }])
  })
  it('removing a ranked option closes the gap', () => {
    const p = plan(rankedStay, { type: 'pick', optionId: 'o-granvia' }, [vote('v1', 'o-granvia', 'sam', 1), vote('v2', 'o-airbnb', 'sam', 2), vote('v3', 'o-ryokan', 'sam', 3)])
    expect(p.voteDeletes).toEqual([{ id: 'v1', optionId: 'o-granvia' }])
    expect(p.voteUpserts).toEqual([
      { optionId: 'o-airbnb', rank: 1 },
      { optionId: 'o-ryokan', rank: 2 },
    ])
    expect(p.outcome).toBe('removed')
  })
  it('repairs old rank-less ranked votes while adding', () => {
    const p = plan(rankedStay, { type: 'pick', optionId: 'o-ryokan' }, [vote('a', 'o-granvia', 'sam'), vote('b', 'o-airbnb', 'sam')])
    expect(p.voteUpserts.map((u) => u.rank).sort()).toEqual([1, 2, 3])
  })
  it('ignores other people\'s votes when ranking', () => {
    const p = plan(rankedStay, { type: 'pick', optionId: 'o-granvia' }, [vote('t1', 'o-airbnb', 'tim', 1)])
    expect(p.voteUpserts).toEqual([{ optionId: 'o-granvia', rank: 1 }])
  })
})

describe('planAnswer: clear, pass, unpass', () => {
  const votes = [vote('v1', 'o-granvia', 'sam', 1), vote('v2', 'o-airbnb', 'sam', 2)]
  it('clear removes every answer of mine', () => {
    const p = plan(rankedStay, { type: 'clear' }, votes)
    expect(p.voteDeletes.map((d) => d.id)).toEqual(['v1', 'v2'])
    expect(p.outcome).toBe('removed')
  })
  it('"No preference" removes my answers and sets the group pass', () => {
    const p = plan(rankedStay, { type: 'pass' }, votes)
    expect(p.voteDeletes.map((d) => d.id)).toEqual(['v1', 'v2'])
    expect(p.pass).toEqual({ op: 'set', kind: 'no_preference' })
    expect(p.toast).toBe('Answer saved')
  })
  it('"None for me" removes my picks and sets the own-choice pass', () => {
    const p = plan(legacySkiRental(), { type: 'pass' })
    expect(p.selectionChanges).toEqual([{ optionId: 'k-skis', selectionId: 'sel-skis', metadata: null }])
    expect(p.pass).toEqual({ op: 'set', kind: 'none_for_me' })
  })
  it('passing twice writes nothing; unpass clears only the pass', () => {
    const passes: ModelPass[] = [{ section_id: 's-stay', user_id: 'sam', kind: 'no_preference' }]
    expect(plan(rankedStay, { type: 'pass' }, [], passes).noop).toBe(true)
    const un = plan(rankedStay, { type: 'unpass' }, [], passes)
    expect(un).toMatchObject({ pass: { op: 'clear' }, voteDeletes: [], outcome: 'removed' })
  })
  it('refuses to pass when the passes table is unavailable and never clears an unknown pass', () => {
    const r = planAnswer({ section: rankedStay, userId: 'sam', gate: OPEN, votes: [], passes: undefined }, { type: 'pass' })
    expect(r.ok).toBe(false)
    const pick = plan(rankedStay, { type: 'pick', optionId: 'o-granvia' }, [], undefined)
    expect(pick.pass).toBeNull()
  })
})

describe('planAnswer: own-choice order', () => {
  const s = legacySkiRental()
  const items = (rows: Parameters<typeof ownRowsToItems>[0]) => ownRowsToItems(rows)
  it('saving an unchanged order is a no-op', () => {
    const rows = control(s).own!.rows
    expect(plan(s, { type: 'save_own', items: items(rows) }).noop).toBe(true)
  })
  it('inserts new lines with the order metadata, updates changed ones, deletes unchecked ones', () => {
    const rows = control(s).own!.rows.map((r) =>
      r.optionId === 'k-skis' ? recomputeOwnRow(r, { quantity: 3 }) : r.optionId === 'k-helmet' ? recomputeOwnRow(r, { checked: true, quantity: 2 }) : r
    )
    const p = plan(s, { type: 'save_own', items: items(rows) })
    expect(p.selectionChanges).toEqual([
      { optionId: 'k-skis', selectionId: 'sel-skis', metadata: { start_date: '2027-02-06', end_date: '2027-02-11', variant: 'Adult', quantity: 3 } },
      { optionId: 'k-helmet', selectionId: null, metadata: { start_date: '2027-02-06', end_date: '2027-02-11', quantity: 2 } },
    ])
    const removed = plan(s, { type: 'save_own', items: items(rows.map((r) => recomputeOwnRow(r, { checked: false }))) })
    expect(removed.selectionChanges).toEqual([{ optionId: 'k-skis', selectionId: 'sel-skis', metadata: null }])
    expect(removed.outcome).toBe('removed')
  })
  it('saving an order clears a "None for me" pass', () => {
    const zed: ModelViewer = { userId: 'zed', tripFinished: false }
    const rows = control(s, [], [], zed).own!.rows
    const checked = recomputeOwnRow(rows[1], { checked: true })
    const passes: ModelPass[] = [{ section_id: 's-ski', user_id: 'zed', kind: 'none_for_me' }]
    const p = plan(s, { type: 'save_own', items: items([rows[0], checked, rows[2]]) }, [], passes, zed)
    expect(p.pass).toEqual({ op: 'clear' })
    expect(p.selectionChanges[0]).toMatchObject({ optionId: 'k-helmet', selectionId: null })
  })
  it('group picks are refused on an own choice and save_own on a group choice', () => {
    expect(planAnswer({ section: s, userId: 'sam', gate: answerGate(s, me), votes: [], passes: [] }, { type: 'pick', optionId: 'k-skis' }).ok).toBe(false)
    expect(planAnswer({ section: tripDates, userId: 'sam', gate: answerGate(tripDates, me), votes: [], passes: [] }, { type: 'save_own', items: [] }).ok).toBe(false)
  })
})

describe('planAnswer: gates', () => {
  it('refuses every action on a decided question, with the reason', () => {
    const decided = { ...rankedStay, status: 'completed' }
    const r = planAnswer({ section: decided, userId: 'sam', gate: answerGate(decided, me), votes: [], passes: [] }, { type: 'pick', optionId: 'o-granvia' })
    expect(r).toEqual({ ok: false, reason: 'This question is decided, so answers are closed.' })
  })
  it('refuses locked options and unknown options', () => {
    const locked = section('s-l', { options: [option('a', 'A', { locked: true }), option('b', 'B')] })
    expect(planAnswer({ section: locked, userId: 'sam', gate: answerGate(locked, me), votes: [], passes: [] }, { type: 'pick', optionId: 'a' }).ok).toBe(false)
    expect(planAnswer({ section: locked, userId: 'sam', gate: answerGate(locked, me), votes: [], passes: [] }, { type: 'pick', optionId: 'zzz' }).ok).toBe(false)
  })
})

describe('applying a plan to cached lists', () => {
  it('votes: deletes by id and upserts replace the same option', () => {
    const p = plan(rankedStay, { type: 'pick', optionId: 'o-granvia' }, [vote('v1', 'o-granvia', 'sam', 1), vote('v2', 'o-airbnb', 'sam', 2)])
    const after = applyPlanToVotes([vote('v1', 'o-granvia', 'sam', 1), vote('v2', 'o-airbnb', 'sam', 2), vote('t', 'o-airbnb', 'tim', 1)], p, (u) => vote(`optimistic-${u.optionId}`, u.optionId, 'sam', u.rank))
    expect(after.map((v) => [v.user_id, v.option_id, v.rank])).toEqual([
      ['tim', 'o-airbnb', 1],
      ['sam', 'o-airbnb', 1],
    ])
  })
  it('passes: set then clear', () => {
    const set = plan(rankedStay, { type: 'pass' })
    const withPass = applyPlanToPasses([], set)
    expect(withPass).toEqual([{ section_id: 's-stay', user_id: 'sam', kind: 'no_preference' }])
    const un = plan(rankedStay, { type: 'unpass' }, [], withPass)
    expect(applyPlanToPasses(withPass, un)).toEqual([])
  })
  it('selections: inserts, updates and deletes inside the section only', () => {
    const s = legacySkiRental()
    const rows = control(s).own!.rows.map((r) => (r.optionId === 'k-helmet' ? recomputeOwnRow(r, { checked: true }) : r.optionId === 'k-skis' ? recomputeOwnRow(r, { checked: false }) : r))
    const p = plan(s, { type: 'save_own', items: ownRowsToItems(rows) })
    const sections = [{ ...s, options: s.options.map((o) => ({ ...o, selections: (o.selections ?? []).map((x) => ({ ...x, metadata: x.metadata ?? null })) })) }] as unknown as Parameters<typeof applyPlanToSelections>[0]
    const out = applyPlanToSelections(sections, p, (c) => ({ id: `optimistic-${c.optionId}`, user_id: 'sam', metadata: c.metadata })) as unknown as Array<{ options: Array<{ id: string; selections: Array<{ id: string; user_id: string }> }> }>
    const byId = Object.fromEntries(out[0].options.map((o) => [o.id, o.selections.map((x) => x.id)]))
    expect(byId['k-skis']).toEqual(['sel-other'])
    expect(byId['k-helmet']).toEqual(['optimistic-k-helmet'])
  })
})

describe('copy helpers', () => {
  it('ordinals and date spans', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd'])
    expect(formatDateSpan('2026-08-17', '2026-08-21')).toBe('17–21 Aug')
    expect(formatDateSpan('2026-08-28', '2026-09-03')).toBe('28 Aug – 3 Sep')
    expect(formatDateSpan('2026-08-17', '2026-08-17')).toBe('17 Aug')
    expect(formatDateSpan('2026-12-30', '2027-01-03')).toBe('30 Dec 2026 – 3 Jan 2027')
  })
  it('surfaces the closed-question trigger as answer wording, from Errors and plain objects', () => {
    const expected = 'Answers are closed for this question, so your answer was not saved.'
    expect(describeAnswerError(new Error('Voting is closed for this question'))).toBe(expected)
    expect(describeAnswerError({ message: 'x', hint: 'voting_closed' })).toBe(expected)
    expect(describeAnswerError(new Error('new row violates row-level security policy'))).toBe("You can't answer this question.")
    expect(describeAnswerError(new Error('relation "public.question_passes" does not exist'))).toMatch(/isn't available yet/)
    expect(describeAnswerError(null)).toBe('Your answer could not be saved.')
  })
})

describe('legacy ranked votes with a null rank', () => {
  // Ranked votes used to be written with rank: null (nothing assigned ranks).
  const legacy = [vote('a', 'o-granvia', 'sam'), vote('b', 'o-airbnb', 'sam'), vote('c', 'o-ryokan', 'sam')]
  it('count as answered (read model and card chip)', () => {
    expect(control(rankedStay, legacy).myState).toBe('answered')
    const card = buildQuestionCardModel({
      section: rankedStay,
      userId: 'sam',
      votes: legacy,
      passes: [],
      participants: [{ user_id: 'sam', active: true, confirmation_status: 'confirmed' }],
      trip: { status: 'booking_details', start_date: '2027-02-06', end_date: '2027-02-11' },
    })
    expect(card.viewerState).toBe('answered')
  })
  it('re-answering writes ranks 1..n, in the order they were cast, and never nulls', () => {
    const add = plan(rankedStay, { type: 'pick', optionId: 'o-granvia' }, legacy.slice(1))
    expect(add.voteUpserts).toEqual([
      { optionId: 'o-airbnb', rank: 1 },
      { optionId: 'o-ryokan', rank: 2 },
      { optionId: 'o-granvia', rank: 3 },
    ])
    const remove = plan(rankedStay, { type: 'pick', optionId: 'o-granvia' }, legacy)
    expect(remove.voteDeletes).toEqual([{ id: 'a', optionId: 'o-granvia' }])
    expect(remove.voteUpserts).toEqual([
      { optionId: 'o-airbnb', rank: 1 },
      { optionId: 'o-ryokan', rank: 2 },
    ])
  })
})

describe('planAnswer: save_own keeps invisible rows and unknown metadata (B4)', () => {
  const fx = (selMeta: Record<string, unknown>, extra: { cancelled?: boolean } = {}) =>
    section('s-own', {
      metadata: { decision_shape: 'personal' },
      options: [
        option('a', 'Skis', { selections: [{ id: 'sel-a', user_id: 'sam', metadata: selMeta as never }] }),
        option('b', 'Old helmet', { status: extra.cancelled ? 'cancelled' : 'available', selections: [{ id: 'sel-b', user_id: 'sam', metadata: { quantity: 2, start_date: '2027-02-06' } as never }] }),
        option('c', 'Poles'),
      ],
    })
  const save = (s: ModelSection, items: AnswerAction extends infer A ? (A extends { type: 'save_own'; items: infer I } ? I : never) : never) => plan(s, { type: 'save_own', items })

  it('does not delete or rewrite selections on cancelled options', () => {
    const s = fx({ quantity: 1 }, { cancelled: true })
    const p = save(s, [
      { optionId: 'a', checked: true, quantity: 3 },
      { optionId: 'b', checked: false },
      { optionId: 'c', checked: false },
    ])
    expect(p.selectionChanges.map((c) => c.optionId)).toEqual(['a'])
    expect(p.selectionChanges.find((c) => c.optionId === 'b')).toBeUndefined()
  })
  it('saving an empty order leaves the cancelled-option row alone', () => {
    const p = save(fx({ quantity: 1 }, { cancelled: true }), [{ optionId: 'a', checked: false }])
    expect(p.selectionChanges).toEqual([{ optionId: 'a', selectionId: 'sel-a', metadata: null }])
  })
  it('explicit clear and pass still drop everything, including rows on cancelled options', () => {
    const s = fx({ quantity: 1 }, { cancelled: true })
    expect(plan(s, { type: 'clear' }).selectionChanges.map((c) => c.optionId).sort()).toEqual(['a', 'b'])
    expect(plan(s, { type: 'pass' }).selectionChanges.map((c) => c.optionId).sort()).toEqual(['a', 'b'])
  })
  it('round-trips all four keys and omits variant/dates when empty', () => {
    const all = { start_date: '2027-02-06', end_date: '2027-02-11', variant: 'Adult', quantity: 2 }
    const same = save(fx(all, { cancelled: true }), [{ optionId: 'a', checked: true, startDate: '2027-02-06', endDate: '2027-02-11', variant: 'Adult', quantity: 2 }])
    expect(same.noop).toBe(true)
    const changed = save(fx(all, { cancelled: true }), [{ optionId: 'a', checked: true, startDate: '2027-02-07', endDate: '2027-02-11', variant: null, quantity: 2 }])
    expect(changed.selectionChanges[0].metadata).toEqual({ start_date: '2027-02-07', end_date: '2027-02-11', quantity: 2 })
  })
  it('legacy {} metadata: inserts the standard keys on edit', () => {
    const p = save(fx({}, { cancelled: true }), [{ optionId: 'a', checked: true, startDate: '2027-02-06', endDate: '2027-02-11', quantity: 1 }])
    expect(p.selectionChanges[0]).toEqual({ optionId: 'a', selectionId: 'sel-a', metadata: { start_date: '2027-02-06', end_date: '2027-02-11', quantity: 1 } })
  })
  it('preserves unknown metadata keys when it rewrites a row', () => {
    const p = save(fx({ note: 'x', quantity: 1, variant: 'Kids' }, { cancelled: true }), [{ optionId: 'a', checked: true, startDate: '2027-02-06', endDate: '2027-02-11', quantity: 4 }])
    expect(p.selectionChanges[0].metadata).toEqual({ note: 'x', start_date: '2027-02-06', end_date: '2027-02-11', quantity: 4 })
  })
  it('does not rewrite a row whose known keys are unchanged even with unknown keys', () => {
    const p = save(fx({ note: 'x', quantity: 1 }, { cancelled: true }), [{ optionId: 'a', checked: true, quantity: 1 }])
    expect(p.noop).toBe(true)
  })
})

describe('orderedSteps: never delete before the replacement is stored', () => {
  const types = (p: AnswerPlan) => orderedSteps(p).map((s) => s.type)
  it('choose-one swap: upsert the new vote, then delete the old, then clear the pass', () => {
    const single = section('s-one', { voting_method: 'single', options: [option('a', 'A'), option('b', 'B')] })
    const passes: ModelPass[] = [{ section_id: 's-one', user_id: 'sam', kind: 'no_preference' }]
    const p = plan(single, { type: 'pick', optionId: 'b' }, [vote('v1', 'a', 'sam')], passes)
    expect(types(p)).toEqual(['votes_upsert', 'votes_delete_ids', 'pass_delete'])
  })
  it('swap while the old vote is still optimistic deletes by option id, after the upsert', () => {
    const single = section('s-one', { voting_method: 'single', options: [option('a', 'A'), option('b', 'B')] })
    const p = plan(single, { type: 'pick', optionId: 'b' }, [vote('optimistic-a-sam', 'a', 'sam')])
    expect(types(p)).toEqual(['votes_upsert', 'votes_delete_options'])
  })
  it('pass: store the pass first, then remove the answers', () => {
    const p = plan(rankedStay, { type: 'pass' }, [vote('v1', 'o-granvia', 'sam', 1)])
    expect(types(p)).toEqual(['pass_set', 'votes_delete_ids'])
  })
  it('pass over a stale pass of another kind: delete the stale pass first, then insert', () => {
    const own = legacySkiRental()
    const passes: ModelPass[] = [{ section_id: 's-ski', user_id: 'sam', kind: 'no_preference' }]
    const p = plan(own, { type: 'pass' }, [], passes)
    expect(p.pass).toEqual({ op: 'set', kind: 'none_for_me', replaceExisting: true })
    expect(types(p)).toEqual(['pass_delete', 'pass_set', 'selection'])
  })
  it('un-pass into a real answer writes the answer before deleting the pass', () => {
    const passes: ModelPass[] = [{ section_id: 's-stay', user_id: 'sam', kind: 'no_preference' }]
    const p = plan(rankedStay, { type: 'pick', optionId: 'o-granvia' }, [], passes)
    expect(types(p)).toEqual(['votes_upsert', 'pass_delete'])
  })
  it('ranked removal: delete first, then renumber (a failure leaves a gap, never duplicate ranks)', () => {
    const votes = [vote('v1', 'o-airbnb', 'sam', 1), vote('v2', 'o-granvia', 'sam', 2), vote('v3', 'o-ryokan', 'sam', 3)]
    const p = plan(rankedStay, { type: 'pick', optionId: 'o-airbnb' }, votes)
    expect(types(p)).toEqual(['votes_delete_ids', 'votes_upsert'])
  })
  it('ranked add writes the new rank without deleting anything', () => {
    const p = plan(rankedStay, { type: 'pick', optionId: 'o-ryokan' }, [vote('v1', 'o-airbnb', 'sam', 1)])
    expect(types(p)).toEqual(['votes_upsert'])
  })
  it('save_own: new/updated lines are written before removed ones', () => {
    const s = legacySkiRental()
    const rows = control(s).own!.rows.map((r) => (r.optionId === 'k-helmet' ? recomputeOwnRow(r, { checked: true }) : r.optionId === 'k-skis' ? recomputeOwnRow(r, { checked: false }) : r))
    const steps = orderedSteps(plan(s, { type: 'save_own', items: ownRowsToItems(rows) }))
    expect(steps.map((x) => (x.type === 'selection' ? (x.change.metadata === null ? 'del' : 'write') : x.type))).toEqual(['write', 'del'])
  })
})
