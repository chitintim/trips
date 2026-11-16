import { describe, expect, it } from 'vitest'
import { buildQuestionCardModel, type CardInput } from './questionCardModel'
import { legacySkiRental, option, rankedStay, section, tripDates, vote } from './answerFixtures'

const NOW = new Date(2026, 10, 16, 12)
const trip = { status: 'booking_details' as const, start_date: '2027-02-06', end_date: '2027-02-13' }
const people = ['sam', 'tim', 'amy', 'bo'].map((id) => ({ user_id: id, active: true, confirmation_status: 'confirmed' }))

function card(over: Partial<CardInput> & { section: CardInput['section'] }) {
  return buildQuestionCardModel({ userId: 'sam', votes: [], passes: [], participants: people, trip, now: NOW, ...over })
}

describe('QuestionCard model: four states', () => {
  it('Open, needs your answer: warning chip, expanded, count and deadline in the subtitle', () => {
    const m = card({ section: { ...rankedStay, vote_deadline: new Date(2026, 10, 21, 12).toISOString() }, votes: [vote('v1', 'o-granvia', 'tim', 1)] })
    expect(m.stage).toBe('open')
    expect(m.chip).toEqual({ label: 'Needs your answer', tone: 'warning' })
    expect(m.defaultExpanded).toBe(true)
    expect(m.subtitle).toBe('Group choice · Rank your top choices · 1 of 4 answered · closes Sat')
    expect(m.strip?.map((s) => [s.key, s.state])).toEqual([['open', 'current'], ['decided', 'todo'], ['booked', 'todo']])
    expect(m.answersClosed).toBe(false)
  })

  it('Open, answered: success chip, collapsed', () => {
    const m = card({ section: tripDates, votes: [vote('v1', 'd-aug1', 'sam')] })
    expect(m.chip).toEqual({ label: 'Answered ✓', tone: 'success' })
    expect(m.defaultExpanded).toBe(false)
    expect(m.counts).toEqual({ answered: 1, total: 4, label: '1 of 4 answered' })
  })

  it('a pass counts as answered on the chip and in "N of M"', () => {
    const m = card({ section: rankedStay, passes: [{ section_id: 's-stay', user_id: 'sam', kind: 'no_preference' }] })
    expect(m.chip?.label).toBe('Answered ✓')
    expect(m.counts.answered).toBe(1)
  })

  it('Decided: chip, winner, strip at step 2, answers closed', () => {
    const decided = { ...rankedStay, status: 'completed', metadata: { decided_option_id: 'o-granvia' } }
    const m = card({ section: decided, votes: [vote('v1', 'o-airbnb', 'sam', 1)] })
    expect(m.stage).toBe('decided')
    expect(m.chip).toEqual({ label: 'Decided', tone: 'success' })
    expect(m.decided).toEqual({ optionId: 'o-granvia', title: 'Hotel Granvia' })
    expect(m.strip?.map((s) => s.state)).toEqual(['done', 'current', 'todo'])
    expect(m.answersClosed).toBe(true)
    expect(m.deadline).toBeNull()
    expect(m.defaultExpanded).toBe(false)
    expect(m.subtitle).toBe('Group choice · 1 of 4 answered')
  })

  it('Decided with nobody having answered (legacy): no "0 of 4 answered"', () => {
    const decided = { ...rankedStay, status: 'completed', metadata: { decided_option_id: 'o-granvia' } }
    const m = card({ section: decided, votes: [] })
    expect(m.subtitle).toBe('Group choice')
    expect(m.counts.label).toBe('')
  })

  it('Booked: a live booking on the decided option', () => {
    const decided = { ...rankedStay, status: 'completed', metadata: { decided_option_id: 'o-granvia' } }
    const m = card({ section: decided, bookedOptionIds: new Set(['o-granvia']) })
    expect(m.stage).toBe('booked')
    expect(m.chip).toEqual({ label: 'Booked', tone: 'success' })
    expect(m.strip?.map((s) => s.state)).toEqual(['done', 'done', 'current'])
  })

  it('a booking on a non-winning option does not make the card Booked', () => {
    const decided = { ...rankedStay, status: 'completed', metadata: { decided_option_id: 'o-granvia' } }
    expect(card({ section: decided, bookedOptionIds: new Set(['o-ryokan']) }).stage).toBe('decided')
  })

  it('legacy: a booked option on a never-stamped open question shows Booked with that option', () => {
    const legacy = section('s-acc', { title: 'Accommodation', options: [option('a', 'Chalet', { status: 'booked' }), option('b', 'Hotel')] })
    const m = card({ section: legacy })
    expect(m.stage).toBe('booked')
    expect(m.decided).toEqual({ optionId: 'a', title: 'Chalet' })
    expect(m.answersClosed).toBe(true)
  })

  it('Finished trip, never decided: muted, no chip, no strip, no controls', () => {
    const m = card({ section: rankedStay, trip: { ...trip, status: 'trip_completed' } })
    expect(m).toMatchObject({ stage: 'closed', muted: true, chip: null, strip: null, closedNote: 'Closed — no decision recorded', answersClosed: true })
  })

  it('someone who is not coming gets no chip', () => {
    const out = [...people.slice(1), { user_id: 'sam', active: true, confirmation_status: 'declined' }]
    const m = card({ section: rankedStay, participants: out })
    expect(m.chip).toBeNull()
    expect(m.counts.total).toBe(3)
  })

  it('past deadline: the subtitle says so and the card is still Open', () => {
    const m = card({ section: { ...tripDates, vote_deadline: new Date(2026, 10, 1).toISOString() } })
    expect(m.stage).toBe('open')
    expect(m.deadline).toMatchObject({ label: 'deadline passed', passed: true })
  })
})

describe('QuestionCard model: own choice', () => {
  it('open own choice speaks "done" and "Choose your own"', () => {
    const m = card({ section: legacySkiRental('tim') })
    expect(m.shape).toBe('own')
    expect(m.chip?.label).toBe('Needs your answer')
    expect(m.subtitle).toBe('Own choice · Choose your own · 1 of 4 done')
  })
  it('with the passes table unavailable, a no-deadline own choice is not owed (no chip, collapsed)', () => {
    const m = card({ section: legacySkiRental('tim'), passes: undefined })
    expect(m.chip).toBeNull()
    expect(m.defaultExpanded).toBe(false)
  })
  it('a closed own choice says "Orders closed" and has no winner', () => {
    const m = card({ section: { ...legacySkiRental('tim'), status: 'completed' } })
    expect(m.stage).toBe('decided')
    expect(m.decided).toBeNull()
    expect(m.ownClosedLabel).toBe('Orders closed')
  })
  it('"None for me" counts as done', () => {
    const m = card({ section: legacySkiRental('tim'), passes: [{ section_id: 's-ski', user_id: 'sam', kind: 'none_for_me' }] })
    expect(m.chip?.label).toBe('Answered ✓')
    expect(m.counts.answered).toBe(2)
  })
})
