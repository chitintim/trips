import { describe, expect, it } from 'vitest'
import { answerGate, buildAnswerControlModel, buildModelViewer, isViewerOut, type ModelSection, type ModelViewer } from './answerModel'
import { buildQuestionCardModel } from './questionCardModel'
import { legacySkiRental, rankedStay, tripDates } from './answerFixtures'

/**
 * Finished trips and people who are not coming must never get an ENABLED answer
 * control (the live site once showed 57 enabled "Answer" buttons on a finished
 * trip). Everything below goes through the same derivation the UI uses.
 */
const NOW = new Date('2026-11-16T12:00:00Z')
const ongoing = { status: 'booking_details' as const, start_date: '2027-02-06', end_date: '2027-02-11' }
const finished = { status: 'trip_completed' as const, start_date: '2026-05-01', end_date: '2026-05-05' }
const roster = (extra: Record<string, unknown> = {}) => [{ user_id: 'sam', active: true, confirmation_status: 'confirmed', ...extra }]

function anyEnabled(s: ModelSection, viewer: ModelViewer): boolean {
  const m = buildAnswerControlModel({ section: s, viewer, votes: [], passes: [], defaultDates: { start: '2027-02-06', end: '2027-02-11' }, fallbackCurrency: 'EUR', now: NOW.getTime() })
  const rows = m.rows.some((r) => !r.disabled)
  const own = (m.own?.rows ?? []).some((r) => !r.disabled)
  return rows || own || !m.pass.disabled
}

const SHAPES: Array<[string, ModelSection]> = [
  ['ranked group choice', rankedStay],
  ['date question', tripDates],
  ['own choice', legacySkiRental()],
]

describe('answer controls are disabled when the viewer cannot answer', () => {
  it.each(SHAPES)('open question, ongoing trip, active participant: enabled (%s)', (_n, s) => {
    expect(anyEnabled(s, buildModelViewer('sam', roster(), ongoing, NOW))).toBe(true)
  })

  it.each(SHAPES)('finished trip: nothing enabled (%s)', (_n, s) => {
    const viewer = buildModelViewer('sam', roster(), finished, NOW)
    expect(answerGate(s, viewer)).toMatchObject({ canAnswer: false, state: 'finished' })
    expect(anyEnabled(s, viewer)).toBe(false)
  })

  it.each(SHAPES)('decided question: nothing enabled (%s)', (_n, s) => {
    const decided = { ...s, status: 'completed' }
    const viewer = buildModelViewer('sam', roster(), ongoing, NOW)
    expect(answerGate(decided, viewer).state).toBe('decided')
    expect(anyEnabled(decided, viewer)).toBe(false)
  })

  it.each([
    ['declined', { confirmation_status: 'declined' }],
    ['cancelled', { confirmation_status: 'cancelled' }],
    ['inactive', { active: false }],
  ])('viewer %s: nothing enabled', (_n, extra) => {
    for (const [, s] of SHAPES) {
      const viewer = buildModelViewer('sam', roster(extra), ongoing, NOW)
      expect(viewer.out).toBe(true)
      expect(answerGate(s, viewer)).toMatchObject({ canAnswer: false, state: 'out' })
      expect(anyEnabled(s, viewer)).toBe(false)
    }
  })

  it('signed out: nothing enabled', () => {
    const viewer = buildModelViewer(null, roster(), ongoing, NOW)
    expect(answerGate(rankedStay, viewer).state).toBe('signed_out')
    expect(anyEnabled(rankedStay, viewer)).toBe(false)
  })

  it('a viewer missing from the roster (still loading) is not treated as out', () => {
    expect(isViewerOut('sam', [])).toBe(false)
  })

  it('maybe / interested / pending viewers can still answer', () => {
    for (const confirmation_status of ['pending', 'interested', 'conditional', 'confirmed']) {
      expect(isViewerOut('sam', roster({ confirmation_status }))).toBe(false)
    }
  })

  it('a passed answer-by date does NOT lock answers: they stay open until the question is decided (proposal 5.8)', () => {
    const late = { ...rankedStay, vote_deadline: '2026-01-01T00:00:00Z' }
    const viewer = buildModelViewer('sam', roster(), ongoing, NOW)
    expect(answerGate(late, viewer)).toMatchObject({ canAnswer: true, state: 'open' })
    expect(anyEnabled(late, viewer)).toBe(true)
  })

  it('the card model agrees: finished trip or out viewer never reports "needs_answer"', () => {
    const base = { section: rankedStay, userId: 'sam', votes: [], passes: [], trip: ongoing, now: NOW }
    expect(buildQuestionCardModel({ ...base, participants: roster() }).viewerState).toBe('needs_answer')
    expect(buildQuestionCardModel({ ...base, participants: roster(), trip: finished }).viewerState).toBe('closed_no_decision')
    expect(buildQuestionCardModel({ ...base, participants: roster({ confirmation_status: 'declined' }) }).viewerState).toBe('not_applicable')
  })
})
