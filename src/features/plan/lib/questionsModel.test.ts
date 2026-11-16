import { describe, expect, it } from 'vitest'
import { GROUP_HEADINGS, daysBannerText, defaultLens, groupQuestions, questionsEmptyState, selectDaysItems, showAnswerAll } from './questionsModel'
import { option, section, vote } from '../../decisions/lib/answerFixtures'
import type { PlanItem } from './planItems'

const NOW = new Date(2026, 10, 16, 12)
const trip = { status: 'booking_details' as const, start_date: '2027-02-06', end_date: '2027-02-13' }
const finishedTrip = { status: 'booking_details' as const, start_date: '2025-02-06', end_date: '2025-02-13' }
const people = ['sam', 'tim'].map((id) => ({ user_id: id, active: true, confirmation_status: 'confirmed' }))

const two = (id: string, extra: Record<string, unknown> = {}) =>
  section(id, { title: id, options: [option(`${id}-a`, 'A'), option(`${id}-b`, 'B')], ...extra })

const run = (sections: ReturnType<typeof two>[], over = {}) =>
  groupQuestions({ sections, userId: 'sam', votes: [], passes: [], participants: people, trip, now: NOW, ...over })

describe('groupQuestions', () => {
  it('puts needs-your-answer first in Open, then answered, then Decided, then Booked/done', () => {
    const q1 = two('q1')
    const q2 = two('q2')
    const q3 = two('q3', { status: 'completed', metadata: { decided_option_id: 'q3-a' } })
    const q4 = two('q4', { status: 'completed', metadata: { decided_option_id: 'q4-a' } })
    const g = run([q1, q2, q3, q4], {
      votes: [vote('v1', 'q1-a', 'sam')],
      bookedOptionIds: new Set(['q4-a']),
    })
    expect(g.open.map((e) => e.section.id)).toEqual(['q2', 'q1'])
    expect(g.open.map((e) => e.needsAnswer)).toEqual([true, false])
    expect(g.decided.map((e) => e.section.id)).toEqual(['q3'])
    expect(g.booked.map((e) => e.section.id)).toEqual(['q4'])
    expect(g.closed).toHaveLength(0)
    expect(g.needsAnswerCount).toBe(1)
    expect(g.total).toBe(4)
  })

  it('a pass counts as answered', () => {
    const g = run([two('q1')], { passes: [{ section_id: 'q1', user_id: 'sam', kind: 'no_preference' }] })
    expect(g.needsAnswerCount).toBe(0)
  })

  it('skips an open question with no live option but keeps decided ones', () => {
    const empty = section('e', { title: 'e', options: [option('e-a', 'A', { status: 'cancelled' })] })
    const decidedEmpty = section('d', { title: 'd', status: 'completed', options: [option('d-a', 'A', { status: 'cancelled' })] })
    const g = run([empty as never, decidedEmpty as never])
    expect(g.open).toHaveLength(0)
    expect(g.total).toBe(1)
  })

  it('on a finished trip an undecided question is closed, never "needs your answer"', () => {
    const g = run([two('q1')], { trip: finishedTrip })
    expect(g.open).toHaveLength(0)
    expect(g.closed.map((e) => e.stage)).toEqual(['closed'])
    expect(g.booked).toHaveLength(0)
    expect(GROUP_HEADINGS.closed).toBe('Closed \u2014 no decision')
    expect(g.needsAnswerCount).toBe(0)
  })
})

describe('lens defaults', () => {
  it('defaults to Questions only while the viewer owes an answer', () => {
    expect(defaultLens({ needsAnswerCount: 1 })).toBe('questions')
    expect(defaultLens({ needsAnswerCount: 0 })).toBe('days')
  })
  it('shows Answer all from two owed answers', () => {
    expect([0, 1, 2, 5].map(showAnswerAll)).toEqual([false, false, true, true])
  })
  it('banner text', () => {
    expect(daysBannerText(0)).toBeNull()
    expect(daysBannerText(1)).toBe('1 question needs your answer →')
    expect(daysBannerText(3)).toBe('3 questions need your answer →')
  })
})

describe('questionsEmptyState', () => {
  it('participants see no ask; organisers do', () => {
    expect(questionsEmptyState(false)).toMatchObject({ title: 'No questions yet.', showAsk: false, showStarters: false })
    expect(questionsEmptyState(true)).toMatchObject({ showAsk: true, showStarters: true })
  })
})

describe('selectDaysItems', () => {
  const item = (over: Partial<PlanItem>): PlanItem =>
    ({ id: 'x', idKind: 'option', stage: 'proposal', date: null, sectionId: 's', isUnscheduledWinner: false, ...over }) as PlanItem

  it('hides options of open questions, shows events and booked items', () => {
    const r = selectDaysItems(
      [
        item({ id: 'ev', idKind: 'event', stage: 'decided', date: '2027-02-07', sectionId: null }),
        item({ id: 'open-opt', date: '2027-02-08', isUnscheduledWinner: true, sectionId: 'open' }),
        item({ id: 'booked', stage: 'booked', date: '2027-02-09' }),
        item({ id: 'booked-undated', stage: 'booked' }),
      ],
      new Set(['decided'])
    )
    expect(r.scheduled.map((i) => i.id)).toEqual(['ev', 'booked'])
    expect(r.notScheduled.map((i) => i.id)).toEqual(['booked-undated'])
  })

  it('a decided winner with no event is "not scheduled yet"; a losing option is hidden', () => {
    const r = selectDaysItems(
      [
        item({ id: 'win', sectionId: 'decided', isUnscheduledWinner: true, date: '2027-02-08' }),
        item({ id: 'lose', sectionId: 'decided' }),
      ],
      new Set(['decided'])
    )
    expect(r.notScheduled.map((i) => i.id)).toEqual(['win'])
    expect(r.scheduled).toHaveLength(0)
  })
})

import { groupQuestions as gq } from './questionsModel'
describe('booked options are never grouped under Closed (item 9)', () => {
  it('finished trip, legacy-booked option on an unstamped question', () => {
    const section = { id: 's', title: 'Stay', status: 'open', options: [{ id: 'a', title: 'Hotel', status: 'booked' }, { id: 'b', title: 'Hut', status: 'available' }] } as never
    const g = gq({ sections: [section], userId: 'u', votes: [], passes: [], participants: [], trip: { status: 'trip_completed', start_date: '2026-01-01', end_date: '2026-01-05' } as never })
    expect(g.closed).toHaveLength(0)
    expect(g.booked.length + g.decided.length).toBe(1)
  })
})
