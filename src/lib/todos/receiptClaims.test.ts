import { describe, expect, it } from 'vitest'
import { computeTodos, computeWaitingOn, receiptPeopleIds } from './computeTodos'
import { formatWeekdayDayMonth } from './copy'
import type { SnapshotExpense, SnapshotParticipant, TripSnapshot } from './types'

/**
 * Receipts phase 2, the claim to-do for a receipt the payer SENT to the table (`claims_sent_at` set), and the payer's own receipt to-dos.
 * Rules (proposal 2d/2e): the to-do stays until the person replies ("That's everything" or "I wasn't there"), or the claims are closed
 * (`claims_closed_at`), or the trip is frozen. Receipts never sent, and snapshots from before the migration, behave exactly as before.
 */

const NOW = new Date(2026, 10, 16, 12, 0, 0) // Mon 16 Nov 2026, local noon
const FUTURE = new Date(2026, 10, 20, 12, 0, 0).toISOString() // Fri 20 Nov
const PAST = new Date(2026, 10, 15, 12, 0, 0).toISOString()
const SENT_AT = new Date(2026, 10, 14, 12, 0, 0).toISOString()

const person = (id: string, name: string, over: Partial<SnapshotParticipant> = {}): SnapshotParticipant => ({
  user_id: id,
  role: 'participant',
  active: true,
  confirmation_status: 'confirmed',
  user: { full_name: `${name} Smith`, first_name: name },
  ...over,
})

const crew = [person('tim', 'Tim', { role: 'organizer' }), person('sam', 'Sam'), person('chai', 'Chai'), person('ana', 'Ana')]

const lines = [
  { id: 'l1', quantity: 1, total_amount: 30 },
  { id: 'l2', quantity: 1, total_amount: 12 },
  { id: 'l3', quantity: 2, total_amount: 8 },
]
/** Tim paid. Sam claimed l1 himself. */
const base: SnapshotExpense = {
  id: 'e1',
  description: 'Dinner at Kumo',
  amount: 50,
  currency: 'GBP',
  paid_by: 'tim',
  ai_parsed: true,
  status: 'pending_allocation',
  participant_ids: null,
  created_at: new Date(2026, 10, 12, 12, 0, 0).toISOString(), // 4 days before NOW
  claims: [{ user_id: 'sam', source: 'self', created_by: 'sam', line_item_id: 'l1', quantity_claimed: 1, amount_owed: 30 }],
  line_items: lines,
  allocation_link: { code: 'abc123' },
}
const sent = (over: Partial<SnapshotExpense> = {}): SnapshotExpense => ({ ...base, claim_deadline: FUTURE, claims_sent_at: SENT_AT, claims_closed_at: null, responses: [], ...over })

function snap(expenses: SnapshotExpense[], over: Partial<TripSnapshot> = {}): TripSnapshot {
  return {
    trip: {
      id: 'trip1',
      name: 'Japow 2027',
      status: 'confirming_participants',
      start_date: '2027-02-06',
      end_date: '2027-02-13',
      confirmation_enabled: false,
      confirmation_deadline: null,
      base_currency: 'GBP',
      created_by: 'tim',
    },
    participants: crew,
    sections: [],
    votes: [],
    actions: [],
    checklists: [],
    expenses,
    settlements: [],
    travelEvents: [],
    ...over,
  }
}

/** Only the claim to-dos: the organiser's unrelated setup steps are not what these tests are about. */
const todos = (s: TripSnapshot, uid: string) => computeTodos(s, uid, NOW).filter((t) => t.kind === 'claim')
const kinds = (s: TripSnapshot, uid: string) => todos(s, uid).map((t) => t.kind)
const ids = (s: TripSnapshot, uid: string) => todos(s, uid).map((t) => t.id)

describe('claim to-do on a receipt sent to the table', () => {
  it('shows for every non-payer on the receipt, due at the deadline, with "Reply by"', () => {
    const s = snap([sent()])
    for (const uid of ['chai', 'ana']) {
      const [t] = todos(s, uid)
      expect(t).toMatchObject({ kind: 'claim', title: 'Claim your items on Dinner at Kumo (£50)', due: FUTURE, link: '?open=claim:e1', overdue: false, actionLabel: 'Claim' })
      expect(t.subtitle).toBe(`Dinner at Kumo · Reply by ${formatWeekdayDayMonth(FUTURE)}`)
    }
    expect(formatWeekdayDayMonth(FUTURE)).toBe('Fri 20 Nov')
  })

  it('does NOT clear on the first self-made claim: it becomes "Finish ... tap That\'s everything"', () => {
    const [t] = todos(snap([sent()]), 'sam')
    expect(t).toMatchObject({ kind: 'claim', title: `Finish Dinner at Kumo: tap "That's everything"`, actionLabel: 'Finish', due: FUTURE })
  })

  it('clears when the person says "That\'s everything" (done) or "I wasn\'t there" (not_there)', () => {
    expect(kinds(snap([sent({ responses: [{ user_id: 'sam', response: 'done' }] })]), 'sam')).toEqual([])
    expect(kinds(snap([sent({ responses: [{ user_id: 'chai', response: 'not_there' }] })]), 'chai')).toEqual([])
    // someone else's reply changes nothing for me
    expect(kinds(snap([sent({ responses: [{ user_id: 'sam', response: 'done' }] })]), 'chai')).toEqual(['claim'])
  })

  it('a person the payer put down for items still has it, with the amount, until they reply', () => {
    const putDown = [{ user_id: 'chai', source: 'on_behalf', created_by: 'tim', line_item_id: 'l2', quantity_claimed: 1, amount_owed: 12 }]
    const s = snap([sent({ claims: [...base.claims, ...putDown] })])
    const [t] = todos(s, 'chai')
    expect(t).toMatchObject({ kind: 'claim', title: 'Check what Tim put you down for — £12', actionLabel: 'Check' })
    expect(kinds(snap([sent({ claims: [...base.claims, ...putDown], responses: [{ user_id: 'chai', response: 'done' }] })]), 'chai')).toEqual([])
    // the share of the leftovers inside a put-down row is not part of "put you down for"
    const withLeftover = [{ ...putDown[0], quantity_claimed: 1.5, leftover_quantity: 0.5, amount_owed: 17, leftover_amount: 5 }]
    expect(todos(snap([sent({ claims: [...base.claims, ...withLeftover] })]), 'chai')[0].title).toBe('Check what Tim put you down for — £12')
  })

  it('the deadline only orders it: past deadline = overdue, still listed; no deadline = no due', () => {
    const [late] = todos(snap([sent({ claim_deadline: PAST })]), 'chai')
    expect(late).toMatchObject({ kind: 'claim', due: PAST, overdue: true })
    const [none] = todos(snap([sent({ claim_deadline: null })]), 'chai')
    expect(none.due).toBeNull()
    expect(none.subtitle).toBe('Dinner at Kumo')
  })

  it('stays even when every item is claimed or the status is allocated (the person still has to reply)', () => {
    const all = [
      { user_id: 'sam', source: 'self', created_by: 'sam', line_item_id: 'l1', quantity_claimed: 1 },
      { user_id: 'sam', source: 'self', created_by: 'sam', line_item_id: 'l2', quantity_claimed: 1 },
      { user_id: 'sam', source: 'self', created_by: 'sam', line_item_id: 'l3', quantity_claimed: 2 },
    ]
    expect(kinds(snap([sent({ claims: all, status: 'allocated' })]), 'chai')).toEqual(['claim'])
  })

  it('closed (claims_closed_at set) clears everyone; a frozen trip clears everyone', () => {
    const closed = snap([sent({ claims_closed_at: PAST })])
    for (const uid of ['sam', 'chai', 'ana', 'tim']) expect(kinds(closed, uid)).toEqual([])
    const frozen = snap([sent()], { trip: { ...snap([]).trip, settlement_snapshot: { frozen: true } } })
    for (const uid of ['sam', 'chai', 'ana', 'tim']) expect(kinds(frozen, uid)).toEqual([])
  })

  it('"not there" people are not on the receipt; an explicit list limits it; the payer never gets the claim to-do', () => {
    expect(kinds(snap([sent({ participant_ids: ['sam', 'tim'] })]), 'chai')).toEqual([])
    expect(kinds(snap([sent({ participant_ids: ['sam', 'tim', 'chai'] })]), 'chai')).toEqual(['claim'])
    expect(kinds(snap([sent()]), 'tim')).not.toContain('claim')
    // a declined person is out when there is no explicit list AND the trip tracks RSVPs (the database keeps them in when it does not)
    const declined = [...crew.slice(0, 3), person('ana', 'Ana', { confirmation_status: 'declined' })]
    const tracked = snap([sent()], { participants: declined, trip: { ...snap([]).trip, confirmation_enabled: true } })
    expect(kinds(tracked, 'ana')).toEqual([])
    expect(kinds(snap([sent()], { participants: declined }), 'ana')).toEqual(['claim'])
  })

  it('needs no claim link once sent (the table page does not use it)', () => {
    expect(kinds(snap([sent({ allocation_link: null })]), 'chai')).toEqual(['claim'])
  })
})

describe('receipts never sent keep today\'s behaviour', () => {
  const never = (over: Partial<SnapshotExpense> = {}): SnapshotExpense => ({ ...base, claim_deadline: null, claims_sent_at: null, claims_closed_at: null, responses: [], ...over })

  it('claim to-do: no deadline, clears on the first self-made claim, payer exempt, link needed', () => {
    const s = snap([never()])
    const [t] = todos(s, 'chai')
    expect(t).toMatchObject({ kind: 'claim', title: 'Claim your items on Dinner at Kumo (£50)', due: null, subtitle: null })
    expect(kinds(s, 'sam')).toEqual([]) // Sam claimed
    expect(kinds(snap([never({ allocation_link: null })]), 'chai')).toEqual([])
    expect(kinds(snap([never({ status: 'allocated' })]), 'chai')).toEqual([])
  })

  it('responses are ignored on a receipt that was never sent', () => {
    expect(kinds(snap([never({ responses: [{ user_id: 'chai', response: 'done' }] })]), 'chai')).toEqual(['claim'])
  })
})

describe('pre-migration snapshot (columns and table absent) is identical to today', () => {
  it('no new fields = the old rules, and no payer to-dos', () => {
    const old = { ...base }
    delete (old as Partial<SnapshotExpense>).line_items
    const s = snap([old])
    expect(todos(s, 'chai')).toMatchObject([{ kind: 'claim', due: null, title: 'Claim your items on Dinner at Kumo (£50)' }])
    expect(kinds(s, 'sam')).toEqual([])
    expect(kinds(s, 'tim')).toEqual([])
    // with lines and unassigned items, still nothing for the payer: the columns do not exist
    expect(kinds(snap([base]), 'tim')).toEqual([])
  })

  it('columns present but the responses table unreadable: sent receipts fall back to the old rules', () => {
    const noTable = sent({ responses: undefined })
    const s = snap([noTable])
    expect(kinds(s, 'sam')).toEqual([]) // claimed -> cleared, as before
    expect(todos(s, 'chai')[0]).toMatchObject({ due: null, subtitle: null })
  })
})

describe('the payer', () => {
  it('before sending: "Send ... to the table" when people are put down or items are unassigned', () => {
    const putDown = { user_id: 'chai', source: 'on_behalf', created_by: 'tim', line_item_id: 'l2', quantity_claimed: 1, amount_owed: 12 }
    const unsent = (over: Partial<SnapshotExpense> = {}): SnapshotExpense => ({ ...base, claim_deadline: null, claims_sent_at: null, claims_closed_at: null, responses: [], ...over })
    const s = snap([unsent({ claims: [...base.claims, putDown] })])
    const [t] = todos(s, 'tim')
    expect(t).toMatchObject({ kind: 'claim', id: 'claim:e1:payer', title: 'Send Dinner at Kumo to the table', actionLabel: 'Send', link: '?open=claim:e1', due: null })
    expect(t.subtitle).toBe('1 person put down · £8 unassigned')
    // unassigned items alone are enough; a fully assigned receipt with nobody put down is not
    expect(kinds(snap([unsent()]), 'tim')).toEqual(['claim'])
    const everything = [
      { user_id: 'sam', source: 'self', created_by: 'sam', line_item_id: 'l1', quantity_claimed: 1 },
      { user_id: 'sam', source: 'self', created_by: 'sam', line_item_id: 'l2', quantity_claimed: 1 },
      { user_id: 'sam', source: 'self', created_by: 'sam', line_item_id: 'l3', quantity_claimed: 2 },
    ]
    expect(kinds(snap([unsent({ claims: everything })]), 'tim')).toEqual([])
    // others still see today's to-do on an unsent receipt
    expect(kinds(s, 'ana')).toEqual(['claim'])
  })

  it('after sending, before the deadline: nothing for the payer', () => {
    expect(kinds(snap([sent()]), 'tim')).toEqual([])
  })

  it('deadline passed and not applied: "Sort out the rest of ... - £X unassigned", due at the deadline', () => {
    const [t] = todos(snap([sent({ claim_deadline: PAST })]), 'tim')
    expect(t).toMatchObject({ kind: 'claim', id: 'claim:e1:payer', title: 'Sort out the rest of Dinner at Kumo — £20 unassigned', due: PAST, overdue: true, actionLabel: 'Sort out', link: '?open=claim:e1' })
  })

  it('deadline passed, nothing unassigned but people have not replied: still asked; all replied or closed: not', () => {
    const everything = [
      { user_id: 'sam', source: 'self', created_by: 'sam', line_item_id: 'l1', quantity_claimed: 1 },
      { user_id: 'sam', source: 'self', created_by: 'sam', line_item_id: 'l2', quantity_claimed: 1 },
      { user_id: 'sam', source: 'self', created_by: 'sam', line_item_id: 'l3', quantity_claimed: 2 },
    ]
    const late = (over: Partial<SnapshotExpense>) => snap([sent({ claim_deadline: PAST, claims: everything, ...over })])
    expect(todos(late({}), 'tim')[0].title).toBe('Sort out the rest of Dinner at Kumo — 3 people have not replied')
    const allIn = ['sam', 'chai', 'ana'].map((u) => ({ user_id: u, response: 'done' }))
    expect(kinds(late({ responses: allIn }), 'tim')).toEqual([])
    expect(kinds(snap([sent({ claim_deadline: PAST, claims_closed_at: NOW.toISOString() })]), 'tim')).toEqual([])
  })

  it('at most 3 receipt to-dos, the oldest deadline first; frozen = none', () => {
    const many = ['a', 'b', 'c', 'd'].map((n, i) => sent({ id: `e${n}`, description: `Meal ${n}`, claim_deadline: new Date(2026, 10, 10 + i, 12).toISOString() }))
    const s = snap(many)
    expect(ids(s, 'tim')).toEqual(['claim:ea:payer', 'claim:eb:payer', 'claim:ec:payer'])
    const frozen = snap(many, { trip: { ...snap([]).trip, settlement_snapshot: { frozen: true } } })
    expect(kinds(frozen, 'tim')).toEqual([])
  })

  it('"Send to the table" only for receipts from the last 14 days, on a trip that is not finished (old receipts do not flood the payer)', () => {
    const unsent = (over: Partial<SnapshotExpense> = {}): SnapshotExpense => ({ ...base, claim_deadline: null, claims_sent_at: null, claims_closed_at: null, responses: [], ...over })
    const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
    expect(kinds(snap([unsent({ created_at: day(13) })]), 'tim')).toEqual(['claim'])
    expect(kinds(snap([unsent({ created_at: day(15) })]), 'tim')).toEqual([])
    expect(kinds(snap([unsent({ created_at: null })]), 'tim')).toEqual([])
    expect(kinds(snap([unsent({ created_at: undefined })]), 'tim')).toEqual([])
    // a finished (never frozen) trip: none, however recent
    const finished = snap([unsent()], { trip: { ...snap([]).trip, start_date: '2026-10-01', end_date: '2026-10-10' } })
    expect(kinds(finished, 'tim')).toEqual([])
    // 20 old receipts: nothing; two new ones: two
    const olds = Array.from({ length: 20 }, (_, i) => unsent({ id: `old${i}`, created_at: day(40 + i) }))
    expect(kinds(snap(olds), 'tim')).toEqual([])
    expect(kinds(snap([...olds, unsent({ id: 'n1' }), unsent({ id: 'n2' })]), 'tim')).toEqual(['claim', 'claim'])
  })

  it('"Sort out the rest" waits for the daily job (20 hours after the deadline), then stays', () => {
    const justPassed = sent({ claim_deadline: new Date(NOW.getTime() - 15 * 3_600_000).toISOString() })
    expect(kinds(snap([justPassed]), 'tim')).toEqual([])
    const longPassed = sent({ claim_deadline: new Date(NOW.getTime() - 21 * 3_600_000).toISOString() })
    expect(todos(snap([longPassed]), 'tim')[0].title).toContain('Sort out the rest')
  })

  it('"Sort out the rest" stays however old the receipt is', () => {
    const old = sent({ claim_deadline: PAST, created_at: new Date(2026, 5, 1).toISOString() })
    expect(todos(snap([old]), 'tim')[0].title).toContain('Sort out the rest')
  })
})

describe('who is on the receipt (one rule, the database\'s _receipt_tagged)', () => {
  const roster = [
    { user_id: 'tim', active: true, confirmation_status: 'confirmed' },
    { user_id: 'sam', active: true, confirmation_status: 'confirmed' },
    { user_id: 'dec', active: true, confirmation_status: 'declined' },
    { user_id: 'new', active: true, confirmation_status: 'invited' },
    { user_id: 'gone', active: false, confirmation_status: 'confirmed' },
  ]
  const e = (over = {}) => ({ paid_by: 'tim', participant_ids: null, claims: [], responses: [], ...over })
  const ids = (x: ReturnType<typeof e>, conf: boolean) => [...receiptPeopleIds(x, roster, conf)].sort()
  it('RSVP tracking off: declined people are still on a list-less receipt; on: they are not, nor the unconfirmed once somebody confirmed', () => {
    expect(ids(e(), false)).toEqual(['dec', 'new', 'sam', 'tim'])
    expect(ids(e(), true)).toEqual(['sam', 'tim'])
  })
  it('an explicit list is used as given (people with a row on the trip), the payer is not forced in', () => {
    expect(ids(e({ participant_ids: ['sam', 'dec', 'nobody'] }), true)).toEqual(['dec', 'sam'])
  })
  it('holding a claim of your own puts you on it; a leftover-only row does not; "wasn\'t there" removes you unless you are the payer or hold a claim', () => {
    const own = { user_id: 'dec', source: 'self', quantity_claimed: 1 }
    const leftoverOnly = { user_id: 'new', source: 'leftover', quantity_claimed: 0.3, leftover_quantity: 0.3 }
    expect(ids(e({ claims: [own, leftoverOnly] }), true)).toEqual(['dec', 'sam', 'tim'])
    const away = [{ user_id: 'sam', response: 'not_there' }, { user_id: 'tim', response: 'not_there' }]
    expect(ids(e({ responses: away }), true)).toEqual(['tim'])
    expect(ids(e({ responses: [{ user_id: 'dec', response: 'not_there' }], claims: [own] }), true)).toEqual(['dec', 'sam', 'tim'])
  })
  it('a share of a table item (shared_by_all) is not a claim of your own: it neither adds you to the receipt nor protects you from "wasn\'t there"', () => {
    const lines = [{ id: 'bread', shared_by_all: true }, { id: 'steak', shared_by_all: false }]
    const tableShare = { user_id: 'dec', source: 'self', line_item_id: 'bread', quantity_claimed: 1 }
    const ownSteak = { user_id: 'new', source: 'self', line_item_id: 'steak', quantity_claimed: 1 }
    expect(ids(e({ claims: [tableShare, ownSteak], line_items: lines }), true)).toEqual(['new', 'sam', 'tim'])
    const away = [{ user_id: 'dec', response: 'not_there' }, { user_id: 'sam', response: 'not_there' }]
    expect(ids(e({ claims: [tableShare], line_items: lines, responses: away }), true)).toEqual(['tim'])
  })
})

describe('Waiting on', () => {
  it('shows "N of M have replied" on the receipt, with the people who have not replied listed under it', () => {
    const s = snap([sent({ responses: [{ user_id: 'sam', response: 'done' }] })])
    const w = computeWaitingOn(s, NOW)
    const item = w.byItem.find((i) => i.id === 'claim:e1')!
    expect(item.detail).toBe('1 of 3 have replied')
    expect(item.userIds.sort()).toEqual(['ana', 'chai'])
    // never-sent receipts keep the plain row
    expect(computeWaitingOn(snap([{ ...base, claims_sent_at: null, responses: [] }]), NOW).byItem.find((i) => i.id === 'claim:e1')?.detail).toBeUndefined()
  })

  it('every person row equals computeTodos for them (payer rows included)', () => {
    const s = snap([sent({ claim_deadline: PAST }), sent({ id: 'e2', description: 'Lunch', claims_sent_at: null })])
    const w = computeWaitingOn(s, NOW)
    for (const p of s.participants) expect(w.byPerson.find((r) => r.userId === p.user_id)?.count ?? 0).toBe(computeTodos(s, p.user_id, NOW).length)
  })
})
