import { describe, expect, it } from 'vitest'
import { areResultsVisible, buildAnswerControlModel, HIDE_OWN_CHOICE_ANSWERS_KEY, type ModelSection, type ModelViewer } from './answerModel'
import { buildQuestionCardModel } from './questionCardModel'
import { legacySkiRental, option, section, vote } from './answerFixtures'

const NOW = Date.parse('2026-11-16T12:00:00Z')
const viewer: ModelViewer = { userId: 'zed', tripFinished: false, out: false }

function control(s: ModelSection, votes = [] as ReturnType<typeof vote>[]) {
  return buildAnswerControlModel({ section: s, viewer, votes, passes: [], fallbackCurrency: 'EUR', now: NOW })
}

/** The legacy ski rental carries hide_votes_until_close=true: the database default for every old question. */
const ownLegacy = (extra: Partial<Omit<ModelSection, 'options'>> = {}) => ({ ...legacySkiRental(), hide_votes_until_close: true, ...extra })

const groupQ = (extra: Partial<Omit<ModelSection, 'options'>> = {}) => section('s-g', { hide_votes_until_close: true, options: [option('a', 'A'), option('b', 'B')], ...extra })

describe('areResultsVisible', () => {
  it('own choice is visible with the legacy hide_votes_until_close=true', () => {
    expect(areResultsVisible(ownLegacy(), NOW)).toBe(true)
  })
  it('own choice ignores hide_votes_until_close=false too', () => {
    expect(areResultsVisible(ownLegacy({ hide_votes_until_close: false }), NOW)).toBe(true)
  })
  it('group choice is hidden with true until decided', () => {
    expect(areResultsVisible(groupQ(), NOW)).toBe(false)
    expect(areResultsVisible(groupQ({ status: 'completed' }), NOW)).toBe(true)
  })
  it('group choice is visible when false', () => {
    expect(areResultsVisible(groupQ({ hide_votes_until_close: false }), NOW)).toBe(true)
  })
  it('group choice reveals after the answer-by deadline', () => {
    expect(areResultsVisible(groupQ({ vote_deadline: '2026-11-16T11:00:00Z' }), NOW)).toBe(true)
    expect(areResultsVisible(groupQ({ vote_deadline: '2026-11-17T11:00:00Z' }), NOW)).toBe(false)
  })
  it('own choice honours the explicit metadata key until decided or the deadline', () => {
    const hidden = ownLegacy({ metadata: { decision_shape: 'personal', [HIDE_OWN_CHOICE_ANSWERS_KEY]: true } })
    expect(areResultsVisible(hidden, NOW)).toBe(false)
    expect(areResultsVisible({ ...hidden, status: 'completed' }, NOW)).toBe(true)
    expect(areResultsVisible({ ...hidden, vote_deadline: '2026-11-16T11:00:00Z' }, NOW)).toBe(true)
  })
  it('own choice with the key set to false is visible', () => {
    expect(areResultsVisible(ownLegacy({ metadata: { decision_shape: 'personal', [HIDE_OWN_CHOICE_ANSWERS_KEY]: false } }), NOW)).toBe(true)
  })
  it('the key does not affect group choice', () => {
    expect(areResultsVisible(groupQ({ hide_votes_until_close: false, metadata: { [HIDE_OWN_CHOICE_ANSWERS_KEY]: true } }), NOW)).toBe(true)
  })
})

describe('own choice results in the control and card', () => {
  it('shows who chose each item by default (legacy default true)', () => {
    const m = control(ownLegacy())
    expect(m.results.visible).toBe(true)
    expect(m.own!.rows[0]).toMatchObject({ optionId: 'k-skis', count: 2, voterIds: expect.arrayContaining(['sam', 'tim']) })
  })
  it('hides voters and counts when the organiser turned hiding on', () => {
    const m = control(ownLegacy({ metadata: { decision_shape: 'personal', [HIDE_OWN_CHOICE_ANSWERS_KEY]: true } }))
    expect(m.results).toMatchObject({ visible: false })
    expect(m.own!.rows[0]).toMatchObject({ count: null, voterIds: [] })
  })
  it('group choice stays hidden with the default true', () => {
    const g = groupQ()
    const m = control(g, [vote('v1', 'a', 'sam')])
    expect(m.results.visible).toBe(false)
    expect(m.rows[0].voterIds).toEqual([])
  })
  it('card model builds for an own choice with the legacy default', () => {
    const card = buildQuestionCardModel({
      section: ownLegacy(),
      userId: 'zed',
      votes: [],
      passes: [],
      participants: [],
      trip: { start_date: '2027-02-06', end_date: '2027-02-11', status: 'planning' } as never,
    })
    expect(card.stage).toBe('open')
  })
})
