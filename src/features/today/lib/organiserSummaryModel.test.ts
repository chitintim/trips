import { describe, expect, it } from 'vitest'
import { computeTodos, computeWaitingOn } from '../../../lib/todos/computeTodos'
import type { SnapshotParticipant, TripSnapshot } from '../../../lib/todos/types'
import { buildOrganiserSummary } from './organiserSummaryModel'

const NOW = new Date(2026, 10, 16, 12, 0, 0)
const person = (id: string, name: string, role: 'organizer' | 'participant' = 'participant'): SnapshotParticipant => ({
  user_id: id,
  role,
  active: true,
  confirmation_status: 'confirmed',
  user: { full_name: `${name} Smith`, first_name: name },
})
const base = (over: Partial<TripSnapshot>): TripSnapshot => ({
  trip: {
    id: 't',
    name: 'Trip',
    status: 'trip_completed',
    start_date: '2026-03-01',
    end_date: '2026-03-14',
    confirmation_enabled: false,
    confirmation_deadline: null,
    base_currency: 'GBP',
    created_by: 'tim',
  },
  participants: [],
  sections: [],
  votes: [],
  actions: [],
  checklists: [],
  expenses: [],
  settlements: [],
  travelEvents: [],
  ...over,
})
const summaryFor = (s: TripSnapshot, viewer: string) => buildOrganiserSummary(computeWaitingOn(s, NOW), viewer, computeTodos(s, viewer, NOW))

describe('organiser summary: who owes what', () => {
  const crew = [person('tim', 'Tim', 'organizer'), person('salim', 'Salim'), person('chris', 'Chris'), person('ana', 'Ana')]
  const frozen = { ...base({}).trip, settlement_snapshot: { transactions: [] } as never }

  it('names the payer, so "Pay Chris" is not read as the viewer paying', () => {
    const s = base({
      trip: frozen,
      participants: crew,
      settlements: [{ id: 's1', from_user_id: 'salim', to_user_id: 'chris', amount: 105.11, currency: 'GBP', status: 'suggested' }],
    })
    const sum = summaryFor(s, 'tim')
    expect(sum.lines).toEqual(['Salim: pay Chris £105.11'])
    expect(sum.lines.some((l) => l.startsWith('Pay '))).toBe(false)
    expect(sum.headline).toBe('As organizer: waiting on 1 person')
  })

  it('gives each payer their own line', () => {
    const s = base({
      trip: frozen,
      participants: crew,
      settlements: [
        { id: 's1', from_user_id: 'salim', to_user_id: 'chris', amount: 5, currency: 'GBP', status: 'suggested' },
        { id: 's2', from_user_id: 'ana', to_user_id: 'chris', amount: 7, currency: 'GBP', status: 'suggested' },
      ],
    })
    expect(summaryFor(s, 'tim').lines).toEqual(expect.arrayContaining(['Ana: pay Chris £7', 'Salim: pay Chris £5']))
  })
})

describe('organiser summary: money blocked on the freeze', () => {
  const crew = [person('tim', 'Tim', 'organizer'), ...['a', 'b', 'c', 'd'].map((id) => person(id, id.toUpperCase()))]
  const s = base({ participants: crew, balances: { tim: 400, a: -100, b: -100, c: -100, d: -100 } })

  it('never says nobody owes anything while the Freeze to-do says people owe money', () => {
    const sum = summaryFor(s, 'tim')
    expect(sum.nothing).toBe(false)
    expect(sum.headline).toBe("As organizer: 4 people can't settle until you freeze balances")
    expect(sum.headline).not.toContain('Nobody owes')
  })

  it('still says nobody owes anything when nothing is owed or blocked', () => {
    const quiet = base({ participants: crew, balances: { tim: 0, a: 0, b: 0, c: 0, d: 0 } })
    const sum = summaryFor(quiet, 'tim')
    expect(sum.nothing).toBe(true)
    expect(sum.headline).toBe('As organizer: Nobody owes anything right now.')
  })
})
