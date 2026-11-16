import { describe, expect, it } from 'vitest'
import { computeTodos, computeWaitingOn } from './computeTodos'
import type { SnapshotParticipant, SnapshotSettlement, TripSnapshot } from './types'

const NOW = new Date(2026, 10, 16, 12, 0, 0)

const person = (id: string, over: Partial<SnapshotParticipant> = {}): SnapshotParticipant => ({
  user_id: id,
  role: 'participant',
  active: true,
  confirmation_status: 'confirmed',
  user: { full_name: `${id} Smith`, first_name: id },
  ...over,
})

function snap(over: Partial<TripSnapshot>): TripSnapshot {
  return {
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
  }
}

describe('finished trip, balances not frozen (Japan 2026)', () => {
  const ids = ['tim', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const s = snap({
    participants: ids.map((id) => person(id, id === 'tim' ? { role: 'organizer' } : {})),
    balances: { tim: 800, a: -100, b: -100, c: -100, d: -100, e: -100, f: -100, g: -100, h: -100 },
  })

  it('gives the freeze to-do only to the organiser, never to the people it unblocks', () => {
    const w = computeWaitingOn(s, NOW)
    expect(w.byPerson.map((p) => p.userId)).toEqual(['tim'])
    expect(w.byPerson[0].todos.map((t) => t.title)).toEqual(['Freeze balances so people can settle'])
    for (const id of ids.filter((x) => x !== 'tim')) expect(computeTodos(s, id, NOW)).toEqual([])
  })

  it('shows it once By item, with the number of people it blocks', () => {
    const w = computeWaitingOn(s, NOW)
    const item = w.byItem.filter((i) => i.kind === 'org_setup')
    expect(item).toHaveLength(1)
    expect(item[0].userIds).toEqual(['tim'])
    expect(item[0].detail).toBe("8 people can't settle until then")
    expect(item[0].unblocks).toBe(8)
  })

  it('lists several organisers on that one item, still not the others', () => {
    const two = snap({ ...s, participants: ids.map((id) => person(id, id === 'tim' || id === 'a' ? { role: 'organizer' } : {})) })
    const w = computeWaitingOn(two, NOW)
    expect(w.byPerson.map((p) => p.userId).sort()).toEqual(['a', 'tim'])
    expect(w.byItem.filter((i) => i.kind === 'org_setup')[0].userIds.sort()).toEqual(['a', 'tim'])
  })
})

describe('identical payments are told apart (Sailing Sicily)', () => {
  const crew = [person('chris', { role: 'organizer' }), person('tim', { role: 'organizer' }), person('salim')]
  const frozen = { trip: { ...snap({}).trip, settlement_snapshot: { transactions: [] } as never } }
  const paid = (id: string, over: Partial<SnapshotSettlement> = {}): SnapshotSettlement => ({
    id,
    from_user_id: 'tim',
    to_user_id: 'chris',
    amount: 619.18,
    currency: 'GBP',
    status: 'marked_paid',
    ...over,
  })
  const titles = (s: TripSnapshot) => computeTodos(s, 'chris', NOW).filter((t) => t.kind === 'confirm_payment').map((t) => t.title)

  it('leaves a single payment alone', () => {
    expect(titles(snap({ ...frozen, participants: crew, settlements: [paid('p1')] }))).toEqual(['Confirm tim paid you £619.18'])
  })

  it('adds the paid date when two rows read the same', () => {
    const t = titles(
      snap({ ...frozen, participants: crew, settlements: [paid('p1', { settled_at: '2026-06-12T12:00:00Z' }), paid('p2', { settled_at: '2026-06-20T12:00:00Z' })] })
    )
    expect(t).toEqual(['Confirm tim paid you £619.18 (12 Jun)', 'Confirm tim paid you £619.18 (20 Jun)'])
  })

  it('numbers them when nothing else tells them apart, and never prints the same line twice', () => {
    const t = titles(snap({ ...frozen, participants: crew, settlements: [paid('p1'), paid('p2')] }))
    expect(t).toEqual(['Confirm tim paid you £619.18 (1 of 2)', 'Confirm tim paid you £619.18 (2 of 2)'])
    expect(new Set(t).size).toBe(2)
  })

  it('does not emit one to-do per direction or per board grouping: one row, one line', () => {
    const s = snap({ ...frozen, participants: crew, settlements: [paid('p1')] })
    const w = computeWaitingOn(s, NOW)
    const chris = w.byPerson.find((p) => p.userId === 'chris')!
    expect(chris.todos.filter((t) => t.kind === 'confirm_payment')).toHaveLength(1)
    expect(w.byPerson.find((p) => p.userId === 'tim')?.todos.some((t) => t.kind === 'confirm_payment') ?? false).toBe(false)
  })
})

describe('"Ask the group your first question" (organiser setup)', () => {
  const live = { trip: { ...snap({}).trip, status: 'booking_details' as const, start_date: '2027-03-01', end_date: '2027-03-08' } }
  const crew = [person('tim', { role: 'organizer' }), person('ana', { role: 'organizer' }), person('sam')]
  const firstQuestion = (s: TripSnapshot, id: string) => computeTodos(s, id, NOW).filter((t) => t.id === 'org_setup:question')

  it('is on both organisers while no question exists, and on nobody once one does', () => {
    const empty = snap({ ...live, participants: crew })
    expect(firstQuestion(empty, 'tim')).toHaveLength(1)
    expect(firstQuestion(empty, 'ana')).toHaveLength(1)
    expect(firstQuestion(empty, 'sam')).toHaveLength(0)
    const withOne = snap({
      ...live,
      participants: crew,
      sections: [{ id: 'q', title: 'Where?', status: 'in_progress', vote_deadline: null, voting_method: 'single', metadata: null, options: [] }],
    })
    for (const id of ['tim', 'ana', 'sam']) expect(firstQuestion(withOne, id)).toHaveLength(0)
    const w = computeWaitingOn(withOne, NOW)
    expect(w.byItem.some((i) => i.id.includes('question') && i.kind === 'org_setup')).toBe(false)
  })
})
