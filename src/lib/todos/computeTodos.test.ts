import { describe, expect, it } from 'vitest'
import { computeTodos, computeInfo, computeWaitingOn, compareTodos, canAnswerAll, isActionDoneFor } from './computeTodos'
import { answerAllLabel, closesLabel, formatMoney, todoCountLabel, DEEP_LINKS, TODO_ACTION_LABEL } from './copy'
import type { SnapshotParticipant, SnapshotSection, TripSnapshot } from './types'

const NOW = new Date(2026, 10, 16, 12, 0, 0) // Mon 16 Nov 2026, local noon

const person = (id: string, name: string, over: Partial<SnapshotParticipant> = {}): SnapshotParticipant => ({
  user_id: id,
  role: 'participant',
  active: true,
  confirmation_status: 'confirmed',
  user: { full_name: `${name} Smith`, first_name: name },
  ...over,
})

const question = (id: string, title: string, over: Partial<SnapshotSection> = {}): SnapshotSection => ({
  id,
  title,
  status: 'in_progress',
  vote_deadline: null,
  voting_method: 'single',
  metadata: null,
  options: [
    { id: `${id}-a`, title: `${title} A`, status: 'available', selections: [] },
    { id: `${id}-b`, title: `${title} B`, status: 'available', selections: [] },
  ],
  ...over,
})

function snap(over: Partial<TripSnapshot> = {}): TripSnapshot {
  return {
    trip: {
      id: 'trip1',
      name: 'Japow 2027',
      status: 'confirming_participants',
      start_date: '2027-02-06',
      end_date: '2027-02-13',
      confirmation_enabled: true,
      confirmation_deadline: null,
      base_currency: 'GBP',
      created_by: 'tim',
    },
    participants: [person('tim', 'Tim', { role: 'organizer' }), person('sam', 'Sam'), person('chai', 'Chai', { confirmation_status: 'pending' })],
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

const kinds = (s: TripSnapshot, uid: string) => computeTodos(s, uid, NOW).map((t) => t.kind)

// ---------------------------------------------------------------------------
// Fixture: Japow (upcoming; RSVP pending; a question with no deadline)
// ---------------------------------------------------------------------------
describe('Japow: upcoming trip, RSVP pending, question with no deadline', () => {
  const japow = snap({ sections: [question('q-stay', 'Where are we staying?')] })

  it('pending person owes the RSVP and the open question; copy and links are exact', () => {
    const todos = computeTodos(japow, 'chai', NOW)
    expect(todos.map((t) => t.id)).toEqual(['rsvp:trip1', 'answer:q-stay'])
    const [rsvp, answer] = todos
    expect(rsvp.title).toBe('Are you coming to Japow 2027?')
    expect(rsvp.actionLabel).toBe('Answer')
    expect(rsvp.link).toBe('?open=rsvp')
    expect(answer.title).toBe('Where are we staying?')
    expect(answer.subtitle).toBe('Group choice · 0 of 3 answered')
    expect(answer.due).toBeNull()
    expect(answer.overdue).toBe(false)
    expect(answer.link).toBe('?open=question:q-stay')
  })

  it('a question with no deadline is still a to-do; answering removes it', () => {
    expect(kinds(japow, 'sam')).toEqual(['answer'])
    const answered = snap({ ...japow, votes: [{ option_id: 'q-stay-a', user_id: 'sam' }] })
    expect(kinds(answered, 'sam')).toEqual([])
  })

  it('organiser sees decide once everyone who is asked has answered (pending people are asked too)', () => {
    const two = snap({ ...japow, votes: [{ option_id: 'q-stay-a', user_id: 'tim' }, { option_id: 'q-stay-a', user_id: 'sam' }] })
    // Chai (no reply yet) still holds the to-do, so it is NOT "all answered".
    expect(computeTodos(two, 'tim', NOW).map((x) => x.kind)).toEqual([])
    expect(kinds(two, 'chai')).toContain('answer')
    const all = snap({ ...japow, votes: [...two.votes, { option_id: 'q-stay-a', user_id: 'chai' }] })
    const t = computeTodos(all, 'tim', NOW)
    expect(t.map((x) => x.kind)).toEqual(['org_decide'])
    expect(t[0].group).toBe('organiser')
    expect(t[0].title).toBe('Decide: Where are we staying? (all 3 answered)')
  })

  it('D8: whoever holds an answer to-do is exactly who is counted in "N of M answered"', () => {
    const s = snap({
      ...japow,
      participants: [...japow.participants, person('wl', 'Wl', { confirmation_status: 'waitlist' }), person('no', 'No', { confirmation_status: 'declined' }), person('left', 'Left', { active: false })],
    })
    const holders = s.participants.filter((p) => computeTodos(s, p.user_id, NOW).some((t) => t.kind === 'answer')).map((p) => p.user_id).sort()
    const todo = computeTodos(s, 'sam', NOW).find((t) => t.kind === 'answer')!
    expect(holders).toEqual(['chai', 'sam', 'tim', 'wl'])
    expect(todo.progress).toEqual({ done: 0, total: holders.length })
  })

  it('deadlines affect ordering and overdue only, never existence', () => {
    const s = snap({
      sections: [
        question('late', 'Late one', { vote_deadline: new Date(2026, 10, 10, 12).toISOString() }),
        question('soon', 'Soon one', { vote_deadline: new Date(2026, 10, 20, 12).toISOString() }),
        question('none', 'No deadline'),
      ],
    })
    const t = computeTodos(s, 'sam', NOW)
    expect(t.map((x) => x.entityId)).toEqual(['late', 'soon', 'none'])
    expect(t[0].overdue).toBe(true)
    expect(t[0].subtitle).toContain('deadline passed')
    expect(t[1].subtitle).toBe('Group choice · 0 of 3 answered · closes Fri')
  })

  it('RSVP off: no rsvp to-do and statuses are ignored', () => {
    const off = snap({ ...japow, trip: { ...japow.trip, confirmation_enabled: false } })
    expect(kinds(off, 'chai')).toEqual(['answer'])
  })

  it('RSVP rules: conditional date arrived, interested only with a deadline', () => {
    const base = snap()
    const cond = snap({ participants: [...base.participants.slice(0, 2), person('c', 'C', { confirmation_status: 'conditional', conditional_date: '2026-11-16' })] })
    expect(kinds(cond, 'c')).toEqual(['rsvp'])
    const future = snap({ participants: [...base.participants.slice(0, 2), person('c', 'C', { confirmation_status: 'conditional', conditional_date: '2026-12-01' })] })
    expect(kinds(future, 'c')).toEqual([])
    const interested = (deadline: string | null) =>
      snap({ trip: { ...base.trip, confirmation_deadline: deadline }, participants: [...base.participants.slice(0, 2), person('c', 'C', { confirmation_status: 'interested' })] })
    expect(kinds(interested(null), 'c')).toEqual([])
    const withDeadline = computeTodos(interested('2026-12-01T12:00:00.000Z'), 'c', NOW)
    expect(withDeadline.map((t) => t.kind)).toEqual(['rsvp'])
    expect(withDeadline[0].due).toBe('2026-12-01T12:00:00.000Z')
  })
})

// ---------------------------------------------------------------------------
// Fixture: Japan 2026 (finished; 9 open questions; legacy booked options)
// ---------------------------------------------------------------------------
describe('Japan 2026: finished trip with open questions and legacy booked options', () => {
  const open = Array.from({ length: 9 }, (_, i) => question(`j${i}`, `Question ${i}`))
  // Legacy: an option is booked while its question was never closed.
  open[0] = question('j0', 'Accommodation', {
    options: [{ id: 'j0-a', title: 'Tokyo Airbnb', status: 'booked', selections: [] }, { id: 'j0-b', title: 'Hotel', status: 'available', selections: [] }],
  })
  const japan = snap({
    trip: { id: 'japan', name: 'Japan 2026', status: 'trip_completed', start_date: '2026-03-01', end_date: '2026-03-14', confirmation_enabled: true, confirmation_deadline: null, base_currency: 'GBP', created_by: 'tim' },
    participants: [person('tim', 'Tim', { role: 'organizer' }), person('sam', 'Sam'), person('chai', 'Chai', { confirmation_status: 'pending' })],
    sections: open,
    actions: [{ id: 'act', title: 'Book flights', assigned_to: null, deadline_kind: 'fixed', due_date: '2026-01-01', completed_at: null, section_id: null }],
    travelEvents: [],
  })

  it('open questions on a finished trip are never to-dos, for anyone', () => {
    for (const uid of ['tim', 'sam', 'chai']) expect(computeTodos(japan, uid, NOW)).toEqual([])
    expect(computeWaitingOn(japan, NOW).totalTodos).toBe(0)
  })

  it('the finished rule is by effective stage: stored status upgraded by dates', () => {
    const stale = snap({ ...japan, trip: { ...japan.trip, status: 'booking_details' } })
    expect(computeTodos(stale, 'sam', NOW)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Fixture: Sicily (finished; money owed; group actions long overdue)
// ---------------------------------------------------------------------------
describe('Sicily: finished trip with money owed and long-overdue group actions', () => {
  const sicily = snap({
    trip: { id: 'sicily', name: 'Sicily', status: 'trip_completed', start_date: '2025-06-01', end_date: '2025-06-08', confirmation_enabled: true, confirmation_deadline: null, base_currency: 'GBP', created_by: 'tim', settlement_snapshot: { frozen: true } },
    participants: [person('tim', 'Tim', { role: 'organizer' }), person('sam', 'Sam'), person('chai', 'Chai'), person('out', 'Out', { confirmation_status: 'declined' })],
    actions: [{ id: 'old', title: 'Send passport copies', assigned_to: null, deadline_kind: 'fixed', due_date: '2025-04-01', completed_at: null, section_id: null }],
    balances: { tim: 5000, sam: -4698.61, chai: -301.39, out: -50 },
    settlements: [{ id: 'st1', from_user_id: 'chai', to_user_id: 'tim', amount: 301.39, currency: 'GBP', status: 'suggested' }],
  })

  it('only money to-dos, no overdue actions', () => {
    const sam = computeTodos(sicily, 'sam', NOW)
    expect(sam.map((t) => t.kind)).toEqual(['pay'])
    expect(sam[0].title).toBe('Settle up: you owe £4,698.61')
    expect(sam[0].actionLabel).toBe('Settle up')
    expect(sam[0].link).toBe('?open=settle')
  })

  it('a suggested settlement replaces the generic settle-up row', () => {
    const chai = computeTodos(sicily, 'chai', NOW)
    expect(chai).toHaveLength(1)
    expect(chai[0]).toMatchObject({ id: 'pay:st1', title: 'Pay Tim £301.39', link: '?open=payment:st1', actionLabel: 'Pay' })
  })

  it('money follows you out: a declined person still owes', () => {
    expect(computeTodos(sicily, 'out', NOW).map((t) => t.kind)).toEqual(['pay'])
  })

  it('the payee confirms marked-paid payments; marked-paid payer is not asked to settle again', () => {
    const marked = snap({
      ...sicily,
      settlements: [{ id: 'st2', from_user_id: 'sam', to_user_id: 'tim', amount: 4698.61, currency: 'GBP', status: 'marked_paid' }],
    })
    expect(computeTodos(marked, 'sam', NOW)).toEqual([])
    const tim = computeTodos(marked, 'tim', NOW)
    expect(tim.map((t) => t.kind)).toEqual(['confirm_payment'])
    expect(tim[0].title).toBe('Confirm Sam paid you £4,698.61')
    expect(tim[0].link).toBe('?open=payment:st2')
  })

  it('D7: only same-currency marked-paid amounts reduce what is owed', () => {
    const eur = snap({
      ...sicily,
      settlements: [{ id: 'st3', from_user_id: 'sam', to_user_id: 'tim', amount: 4000, currency: 'EUR', status: 'marked_paid' }],
    })
    expect(computeTodos(eur, 'sam', NOW)[0].title).toBe('Settle up: you owe £4,698.61')
  })

  it('D7: pay items are per person and a payee who left is named', () => {
    const t = computeTodos(sicily, 'sam', NOW)[0]
    expect(t.id).toBe('pay:settle:sam')
    const wo = computeWaitingOn(sicily, NOW)
    const settle = wo.byItem.filter((i) => i.kind === 'pay' && i.id !== 'pay:st1')
    expect(settle.map((i) => i.userIds).sort()).toEqual([['out'], ['sam']]) // one item each, never merged
    const gone = snap({
      ...sicily,
      allParticipants: [...sicily.participants, person('ex', 'Alex', { active: false })],
      settlements: [{ id: 'st9', from_user_id: 'chai', to_user_id: 'ex', amount: 20, currency: 'GBP', status: 'suggested' }],
    })
    expect(computeTodos(gone, 'chai', NOW)[0].title).toBe('Pay Alex £20')
  })

  it('never frozen: the participant has NO to-do (an info line instead), the organiser gets ONE freeze to-do', () => {
    const unfrozen = snap({ ...sicily, trip: { ...sicily.trip, settlement_snapshot: null } })
    expect(computeTodos(unfrozen, 'sam', NOW)).toEqual([])
    expect(computeTodos(unfrozen, 'chai', NOW)).toEqual([])
    const info = computeInfo(unfrozen, 'sam', NOW)
    expect(info).toHaveLength(1)
    expect(info[0].text).toBe("You'll be able to settle up (you owe £4,698.61) once the organizer finalizes balances")
    expect(computeInfo(sicily, 'sam', NOW)).toEqual([]) // frozen: it is a real Pay to-do instead
    expect(computeInfo(unfrozen, 'tim', NOW)).toEqual([]) // owes nothing
    const tim = computeTodos(unfrozen, 'tim', NOW)
    expect(tim.map((t) => t.id)).toEqual(['org_setup:freeze'])
    expect(tim[0]).toMatchObject({ group: 'organiser', title: 'Freeze balances so people can settle', link: '?open=settle', unblocks: 3 })
    // Waiting on: only the organiser, one item, "Unblocks 3 people", never the participants
    const wo = computeWaitingOn(unfrozen, NOW)
    expect(wo.byPerson.map((p) => p.userId)).toEqual(['tim'])
    expect(wo.byItem).toHaveLength(1)
    expect(wo.byItem[0]).toMatchObject({ id: 'org_setup:' + unfrozen.trip.id + ':freeze', detail: "3 people can't settle until then", userIds: ['tim'] })
    // nobody owes anything: no freeze to-do
    expect(computeTodos(snap({ ...unfrozen, balances: { tim: 0, sam: 0 } }), 'tim', NOW)).toEqual([])
    // a non-organiser never gets it
    expect(computeTodos(unfrozen, 'sam', NOW).some((t) => t.id === 'org_setup:freeze')).toBe(false)
  })

  it('Waiting on groups several receivers confirming payments from one payer into one item', () => {
    const crew = [person('tim', 'Tim', { role: 'organizer' }), person('a', 'Ann'), person('b', 'Bob'), person('c', 'Cat')]
    const mk = (rows: Array<[string, string]>) =>
      snap({
        ...sicily,
        participants: crew,
        balances: {},
        settlements: rows.map(([id, to]) => ({ id, from_user_id: 'tim', to_user_id: to, amount: 619.18, currency: 'GBP', status: 'marked_paid' })),
      })
    const wo = computeWaitingOn(mk([['s1', 'a'], ['s2', 'b'], ['s3', 'c']]), NOW)
    const items = wo.byItem.filter((i) => i.kind === 'confirm_payment')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ title: 'Confirm payment from Tim', detail: '3 payments to confirm' })
    expect(items[0].userIds.sort()).toEqual(['a', 'b', 'c'])
    expect(items[0].todoIds.a).toBe('confirm_payment:s1')
    // each receiver still has exactly their own to-do (counts unchanged)
    expect(wo.byPerson.map((p) => p.count)).toEqual([1, 1, 1])
    // a single payment keeps its own descriptive row
    const single = computeWaitingOn(mk([['s1', 'a']]), NOW).byItem.filter((i) => i.kind === 'confirm_payment')
    expect(single).toHaveLength(1)
    expect(single[0].title).toBe('Confirm Tim paid you £619.18')
  })

  it('an upcoming trip with the same actions would owe them (control)', () => {
    const upcoming = snap({ ...sicily, trip: { ...sicily.trip, status: 'booking_details', start_date: '2027-06-01', end_date: '2027-06-08' } })
    const t = computeTodos(upcoming, 'sam', NOW).find((x) => x.kind === 'task')
    expect(t?.overdue).toBe(true)
    expect(t?.subtitle).toMatch(/^Everyone · overdue by \d+ days$/)
  })
})

// ---------------------------------------------------------------------------
// Rules per kind
// ---------------------------------------------------------------------------
describe('tasks', () => {
  const base = snap({
    sections: [question('qa', 'Pick rooms'), question('own', 'Ski rental', { metadata: { decision_shape: 'personal' } })],
    actions: [
      { id: 'mine', title: 'Get a visa', assigned_to: 'sam', deadline_kind: 'fixed', due_date: '2026-12-12', completed_at: null, section_id: null },
      { id: 'every', title: 'Travel insurance', assigned_to: null, deadline_kind: 'before_trip', due_date: null, completed_at: null, section_id: null },
      { id: 'theirs', title: 'Not mine', assigned_to: 'tim', deadline_kind: 'fixed', due_date: null, completed_at: null, section_id: null },
      { id: 'linked', title: 'Answer ski rental', assigned_to: null, deadline_kind: 'fixed', due_date: null, completed_at: null, section_id: 'own' },
    ],
    checklists: [
      { id: 'c1', title: 'Bluetooth speaker', assigned_to: 'sam', done: false },
      { id: 'c2', title: 'Up for grabs', assigned_to: null, done: false },
      { id: 'c3', title: 'Done thing', assigned_to: 'sam', done: true },
    ],
  })

  it('assigned, Everyone and bring items; up for grabs are not to-dos', () => {
    const sam = computeTodos(base, 'sam', NOW).filter((t) => t.kind === 'task')
    expect(sam.map((t) => t.id).sort()).toEqual(['task:c1', 'task:every', 'task:linked', 'task:mine'])
    const mine = sam.find((t) => t.id === 'task:mine')!
    expect(mine.subtitle).toBe('You · due 12 Dec')
    expect(mine.link).toBe('?open=todo:mine')
    expect(sam.find((t) => t.id === 'task:every')!.subtitle).toBe('Everyone · due 6 Feb')
    const bring = sam.find((t) => t.id === 'task:c1')!
    expect(bring.title).toBe('🎒 Bring: Bluetooth speaker')
    expect(bring.link).toBe('?open=bring:c1')
  })

  it('a linked action auto-ticks when the own-choice question gets a SELECTION', () => {
    const picked = snap({
      ...base,
      sections: [base.sections[0], question('own', 'Ski rental', { metadata: { decision_shape: 'personal' }, options: [{ id: 'own-a', status: 'available', selections: [{ user_id: 'sam' }] }] })],
    })
    expect(computeTodos(picked, 'sam', NOW).some((t) => t.entityId === 'linked')).toBe(false)
    expect(computeTodos(picked, 'sam', NOW).some((t) => t.entityId === 'own')).toBe(false)
    expect(computeTodos(picked, 'chai', NOW).some((t) => t.entityId === 'linked')).toBe(true)
  })

  it('closing the linked question completes the action for everyone', () => {
    const closed = snap({ ...base, sections: [base.sections[0], { ...base.sections[1], status: 'completed' }] })
    expect(computeTodos(closed, 'sam', NOW).some((t) => t.entityId === 'linked')).toBe(false)
  })

  it('own-choice answer copy', () => {
    const withDeadline = snap({ ...base, sections: [question('own', 'Ski rental', { metadata: { decision_shape: 'personal' }, vote_deadline: new Date(2026, 11, 20, 12).toISOString() })] })
    const own = computeTodos(withDeadline, 'sam', NOW).find((t) => t.id === 'answer:own')!
    expect(own.actionLabel).toBe('Choose')
    expect(own.subtitle).toBe('Choose your own · 0 of 3 done · closes Sun 20 Dec')
    expect(own.shape).toBe('own')
  })

  it('D2: an Own-choice question with no deadline is a to-do only when passes are available, and "None for me" clears it', () => {
    const ownTodo = (sn: TripSnapshot, who = 'sam') => computeTodos(sn, who, NOW).some((t) => t.id === 'answer:own')
    // Conservative default (passesAvailable omitted/false): not a to-do.
    expect(ownTodo(base)).toBe(false)
    expect(ownTodo(snap({ ...base, passesAvailable: false }))).toBe(false)
    // Passes available: a to-do for everyone who has not answered.
    const avail = snap({ ...base, passesAvailable: true })
    expect(ownTodo(avail)).toBe(true)
    const passed = snap({ ...base, passesAvailable: true, passes: [{ section_id: 'own', user_id: 'sam', kind: 'none_for_me' }] })
    expect(ownTodo(passed)).toBe(false)
    expect(ownTodo(passed, 'tim')).toBe(true) // others still owe it
  })

  it('an Own-choice question WITH a deadline is a to-do whether or not passes are available', () => {
    const withDeadline = (passesAvailable: boolean) =>
      snap({ ...base, passesAvailable, sections: [question('own', 'Ski rental', { metadata: { decision_shape: 'personal' }, vote_deadline: new Date(2026, 11, 20, 12).toISOString() })] })
    expect(computeTodos(withDeadline(false), 'sam', NOW).some((t) => t.id === 'answer:own')).toBe(true)
    expect(computeTodos(withDeadline(true), 'sam', NOW).some((t) => t.id === 'answer:own')).toBe(true)
  })

  it('isActionDoneFor matches the completion rules', () => {
    const a = { id: 'x', title: 't', assigned_to: null, deadline_kind: 'fixed', due_date: null, completed_at: null, section_id: 's', trip_action_completions: [{ user_id: 'u1' }] }
    expect(isActionDoneFor(a, 'u1', new Map())).toBe(true)
    expect(isActionDoneFor(a, 'u2', new Map())).toBe(false)
    expect(isActionDoneFor(a, 'u2', new Map([['s', new Set(['u2'])]]))).toBe(true)
    expect(isActionDoneFor({ ...a, assigned_to: 'u3', completed_at: '2026-01-01' }, 'u3', new Map())).toBe(true)
  })
})

describe('claim, travel, waitlist, scope', () => {
  const receipt = { id: 'e1', description: 'Dinner at Kumo', amount: 86, currency: 'GBP', paid_by: 'tim', ai_parsed: true, status: 'pending_allocation', participant_ids: null, claims: [{ user_id: 'chai' }], allocation_link: { code: 'abc123' } }

  it('claim: itemised, not allocated, I am involved and have not claimed; payer is exempt', () => {
    const s = snap({ expenses: [receipt] })
    const sam = computeTodos(s, 'sam', NOW)
    expect(sam.map((t) => t.kind)).toEqual(['claim'])
    expect(sam[0].title).toBe('Claim your items on Dinner at Kumo (£86)')
    expect(sam[0].link).toBe('?open=claim:e1')
    expect(kinds(s, 'chai')).toEqual(['rsvp'])
    expect(kinds(s, 'tim')).not.toContain('claim')
    expect(kinds(snap({ expenses: [{ ...receipt, status: 'allocated' }] }), 'sam')).toEqual([])
    expect(kinds(snap({ expenses: [{ ...receipt, participant_ids: ['chai'] }] }), 'sam')).toEqual([])
  })

  it('D5: no claim to-do without a usable link, or while balances are frozen', () => {
    expect(kinds(snap({ expenses: [{ ...receipt, allocation_link: null }] }), 'sam')).toEqual([])
    expect(kinds(snap({ expenses: [{ ...receipt, allocation_link: { code: 'x', expires_at: '2026-11-01T00:00:00Z' } }] }), 'sam')).toEqual([])
    expect(kinds(snap({ expenses: [{ ...receipt, allocation_link: { code: 'x', expires_at: '2026-12-01T00:00:00Z' } }] }), 'sam')).toEqual(['claim'])
    const frozen = snap({ expenses: [receipt] })
    frozen.trip.settlement_snapshot = { frozen: true }
    expect(kinds(frozen, 'sam')).toEqual([])
  })

  it('travel: within 30 days, going, no travel events; done when both directions exist', () => {
    const soon = snap({ trip: { ...snap().trip, start_date: '2026-12-10', end_date: '2026-12-17' } })
    const t = computeTodos(soon, 'sam', NOW).find((x) => x.kind === 'travel')!
    expect(t.title).toBe('Add your flights or travel times')
    expect(t.link).toBe('?open=travel-details')
    expect(t.due).toBe('2026-12-03')
    const ev = (dir: string) => ({ title: dir, participant_ids: ['sam'], metadata: { travel_details: true, direction: dir } })
    expect(kinds({ ...soon, travelEvents: [ev('arrival')] }, 'sam')).toContain('travel')
    expect(kinds({ ...soon, travelEvents: [ev('arrival'), ev('departure')] }, 'sam')).not.toContain('travel')
    // far away and not "Ready to go": no
    expect(kinds(snap(), 'sam')).not.toContain('travel')
    // not going yet (RSVP on): no
    expect(kinds(soon, 'chai')).not.toContain('travel')
  })

  it('waitlist offer in the future is a to-do with an expiry deadline', () => {
    const exp = new Date(2026, 10, 18, 12).toISOString()
    const s = snap({ participants: [person('tim', 'Tim', { role: 'organizer' }), person('w', 'W', { confirmation_status: 'waitlist', waitlist_offer_expires_at: exp })] })
    const t = computeTodos(s, 'w', NOW)
    expect(t.map((x) => x.kind)).toEqual(['waitlist_offer'])
    expect(t[0].due).toBe(exp)
    const lapsed = snap({ participants: [person('w', 'W', { confirmation_status: 'waitlist', waitlist_offer_expires_at: new Date(2026, 10, 15).toISOString() })] })
    expect(computeTodos(lapsed, 'w', NOW)).toEqual([])
  })

  it('D1: accepting the offer (status leaves waitlist, timestamp stays) clears the to-do', () => {
    const exp = new Date(2026, 10, 18, 12).toISOString()
    const accepted = snap({ participants: [person('tim', 'Tim', { role: 'organizer' }), person('w', 'W', { confirmation_status: 'confirmed', waitlist_offer_expires_at: exp })] })
    expect(computeTodos(accepted, 'w', NOW).some((t) => t.kind === 'waitlist_offer')).toBe(false)
    expect(computeWaitingOn(accepted, NOW).byItem.some((i) => i.kind === 'waitlist_offer')).toBe(false)
  })

  it('out people only get money to-dos', () => {
    const s = snap({
      participants: [person('tim', 'Tim', { role: 'organizer' }), person('gone', 'Gone', { confirmation_status: 'declined' })],
      sections: [question('q', 'Q')],
      expenses: [{ ...receipt, participant_ids: ['gone'] }],
    })
    expect(kinds(s, 'gone')).toEqual(['claim'])
  })

  it('non-participants get nothing', () => {
    expect(computeTodos(snap({ sections: [question('q', 'Q')] }), 'stranger', NOW)).toEqual([])
  })
})

const crew4 = ['tim', 'sam', 'chai', 'ana']

describe('organiser kinds', () => {
  const decided = (status: string, over: Partial<SnapshotSection> = {}) =>
    question('d', 'Where to stay', {
      status: 'completed',
      section_type: 'accommodation',
      options: [{ id: 'win', title: 'Osaka Airbnb', status, selections: [] }, { id: 'lose', title: 'Hotel', status: 'available', selections: [] }],
      ...over,
    })
  const bookSnap = (section: SnapshotSection, bookings?: TripSnapshot['bookings'], trip: Partial<TripSnapshot['trip']> = {}) =>
    snap({ trip: { ...snap().trip, ...trip }, sections: [section], votes: [{ option_id: 'win', user_id: 'sam' }], bookings, participants: [person('tim', 'Tim', { role: 'organizer' }), person('sam', 'Sam')] })

  it('org_book: decided winner not yet booked; booked option or live booking clears it', () => {
    const s = (status: string, bookings?: TripSnapshot['bookings']) => bookSnap(decided(status), bookings)
    const t = computeTodos(s('available'), 'tim', NOW)
    expect(t.map((x) => x.kind)).toEqual(['org_book'])
    expect(t[0].title).toBe('Book: Osaka Airbnb')
    expect(t[0].actionLabel).toBe('Mark booked')
    expect(t[0].link).toBe('?open=book:win')
    expect(computeTodos(s('booked'), 'tim', NOW)).toEqual([])
    expect(computeTodos(s('available', [{ option_id: 'win', status: 'reserved' }]), 'tim', NOW)).toEqual([])
    expect(computeTodos(s('available', [{ option_id: 'win', status: 'cancelled' }]), 'tim', NOW)).toHaveLength(1)
    // participants never see organiser kinds
    expect(computeTodos(s('available'), 'sam', NOW)).toEqual([])
  })

  it('D3: no Book to-do for the dates poll, date-range options, unbookable types or unknown types', () => {
    const k = (section: SnapshotSection) => kinds(bookSnap(section), 'tim')
    expect(k(decided('available'))).toEqual(['org_book'])
    expect(k(decided('available', { title: 'Trip dates' }))).toEqual([])
    expect(
      k(decided('available', { options: [{ id: 'win', title: '12–19 Jan', status: 'available', metadata: { date_range: { start: '2027-01-12', end: '2027-01-19' } }, selections: [] }, { id: 'lose', title: 'x', status: 'available', selections: [] }] }))
    ).toEqual([])
    expect(k(decided('available', { section_type: 'equipment' }))).toEqual([])
    expect(k(decided('available', { section_type: null }))).toEqual([])
  })

  it('D3: only before the trip starts', () => {
    const ongoing = bookSnap(decided('available'), undefined, { start_date: '2026-11-14', end_date: '2026-11-20', status: 'trip_ongoing' })
    expect(kinds(ongoing, 'tim')).toEqual([])
    const over = bookSnap(decided('available'), undefined, { start_date: '2026-03-01', end_date: '2026-03-08', status: 'trip_completed' })
    expect(kinds(over, 'tim')).toEqual([])
  })

  it('D3: at most 3 Book to-dos at once', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      question(`d${i}`, `Thing ${i}`, { status: 'completed', section_type: 'activities', options: [{ id: `w${i}`, title: `Booking ${i}`, status: 'available', selections: [] }] })
    )
    const s = snap({ sections: many, votes: many.map((_m, i) => ({ option_id: `w${i}`, user_id: 'sam' })), participants: [person('tim', 'Tim', { role: 'organizer' }), person('sam', 'Sam')] })
    expect(computeTodos(s, 'tim', NOW).filter((t) => t.kind === 'org_book')).toHaveLength(3)
  })

  it('org_decide when the deadline has passed, with counts in the copy', () => {
    const s = snap({
      sections: [question('q', 'Where are we staying?', { vote_deadline: new Date(2026, 10, 10, 12).toISOString() })],
      votes: [{ option_id: 'q-a', user_id: 'sam' }],
    })
    const t = computeTodos(s, 'tim', NOW).filter((x) => x.kind === 'org_decide')
    expect(t[0].title).toBe('Decide: Where are we staying? (deadline passed, 1 of 3 answered)')
    expect(t[0].overdue).toBe(true)
  })

  it('own-choice: nothing to decide before the deadline; after it the organiser closes answers (org_decide, different copy)', () => {
    const own = (deadline: string | null) =>
      snap({ sections: [question('own', 'Ski rental', { metadata: { decision_shape: 'personal' }, vote_deadline: deadline })] })
    expect(kinds(own(new Date(2026, 10, 20, 12).toISOString()), 'tim')).toEqual(['answer'])
    const t = computeTodos(own(new Date(2026, 10, 10, 12).toISOString()), 'tim', NOW)
    expect(t.map((x) => x.kind)).toEqual(['answer', 'org_decide'])
    const close = t[1]
    expect(close.title).toBe('Close answers for Ski rental')
    expect(close.link).toBe('?open=decide:own')
    expect(close.group).toBe('organiser')
    // Everyone has answered but there is no deadline: picks stay editable, no to-do.
    const allIn = snap({
      sections: [question('own', 'Ski rental', { metadata: { decision_shape: 'personal' }, options: [{ id: 'o1', title: 'Skis', status: 'available', selections: crew4.map((u) => ({ user_id: u })) }] })],
    })
    expect(kinds(allIn, 'tim')).not.toContain('org_decide')
    // Participants never see it; a closed own-choice question has nothing left.
    expect(kinds(own(new Date(2026, 10, 10, 12).toISOString()), 'sam')).not.toContain('org_decide')
    const closed = snap({ sections: [question('own', 'Ski rental', { status: 'completed', metadata: { decision_shape: 'personal' }, vote_deadline: new Date(2026, 10, 10, 12).toISOString() })] })
    expect(kinds(closed, 'tim')).not.toContain('org_decide')
  })

  describe('decide / tie (slice 4E)', () => {
    const PAST = new Date(2026, 10, 10, 12).toISOString()
    const FUTURE = new Date(2026, 10, 25, 12).toISOString()
    const q = (over: Partial<SnapshotSection> = {}) => question('q', 'Where are we staying?', { vote_deadline: PAST, ...over })
    const withVotes = (section: SnapshotSection, votes: Array<[string, string]>) => snap({ sections: [section], votes: votes.map(([option_id, user_id]) => ({ option_id, user_id })) })
    const orgKinds = (s: TripSnapshot, uid = 'tim') => computeTodos(s, uid, NOW).filter((t) => t.group === 'organiser').map((t) => t.kind)

    it('deadline passed with a clear leader: org_decide linking to decide:<id>', () => {
      const s = withVotes(q(), [['q-a', 'sam'], ['q-a', 'tim'], ['q-b', 'chai']])
      const t = computeTodos(s, 'tim', NOW).find((x) => x.kind === 'org_decide')!
      expect(t.link).toBe('?open=decide:q')
      expect(t.actionLabel).toBe('Decide')
      expect(orgKinds(s)).toEqual(['org_decide'])
    })

    it('deadline passed with a tie: org_tie replaces org_decide (never both), same link', () => {
      const s = withVotes(q(), [['q-a', 'sam'], ['q-b', 'chai']])
      const t = computeTodos(s, 'tim', NOW).filter((x) => x.group === 'organiser')
      expect(t.map((x) => x.kind)).toEqual(['org_tie'])
      expect(t[0].title).toBe('Tie: choose a winner for Where are we staying?')
      expect(t[0].subtitle).toBe('Tied: Where are we staying? A · Where are we staying? B')
      expect(t[0].link).toBe('?open=decide:q')
      expect(t[0].overdue).toBe(true)
    })

    it('the tie uses the resolveDecision rule: ranked polls break a tie on first-choice votes', () => {
      const ranked = q({ voting_method: 'ranked' })
      const clear = snap({ sections: [ranked], votes: [{ option_id: 'q-a', user_id: 'sam', rank: 1 }, { option_id: 'q-b', user_id: 'sam', rank: 2 }, { option_id: 'q-b', user_id: 'chai', rank: 1 }, { option_id: 'q-a', user_id: 'chai', rank: 2 }] })
      // equal Borda and equal first-choice counts: still a tie
      expect(orgKinds(clear)).toEqual(['org_tie'])
    })

    it('a tie is only called once the deadline has passed; before it, everyone answered is org_decide', () => {
      const everyone = ['tim', 'sam', 'chai']
      const votes = everyone.map((u, i): [string, string] => [i % 2 ? 'q-a' : 'q-b', u])
      const open = withVotes(q({ vote_deadline: FUTURE }), votes)
      const t = computeTodos(open, 'tim', NOW).filter((x) => x.group === 'organiser')
      expect(t.map((x) => x.kind)).toEqual(['org_decide'])
      expect(t[0].title).toBe('Decide: Where are we staying? (all 3 answered)')
      // not everyone has answered and the deadline is ahead: nothing yet
      expect(orgKinds(withVotes(q({ vote_deadline: FUTURE }), [['q-a', 'sam']]))).toEqual([])
    })

    it('no answers at all after the deadline is org_decide (not a tie)', () => {
      expect(orgKinds(snap({ sections: [q()] }))).toEqual(['org_decide'])
    })

    it('decided (by anyone, or by the auto-decide job) clears decide and tie at once', () => {
      for (const votes of [[['q-a', 'sam'], ['q-b', 'chai']], [['q-a', 'sam'], ['q-a', 'chai']]] as Array<Array<[string, string]>>) {
        const open = withVotes(q(), votes)
        expect(orgKinds(open)).toHaveLength(1)
        const decided = withVotes(q({ status: 'completed', metadata: { decided_option_id: 'q-a' } }), votes)
        expect(orgKinds(decided).filter((k) => k !== 'org_book')).toEqual([])
      }
    })

    it('the email bridge (nobody marked organiser, created_by null) can never receive decide / tie / book', () => {
      const s = snap({
        trip: { ...snap().trip, created_by: null },
        participants: [person('tim', 'Tim', { role: null }), person('sam', 'Sam', { role: null })],
        sections: [q()],
        votes: [{ option_id: 'q-a', user_id: 'sam' }, { option_id: 'q-b', user_id: 'tim' }],
      })
      for (const uid of ['tim', 'sam']) expect(computeTodos(s, uid, NOW).filter((t) => t.kind.startsWith('org_'))).toEqual([])
    })

    it('every organiser holds it; Waiting on shows ONE item saying any organiser can do it (N)', () => {
      const s = snap({
        participants: [person('tim', 'Tim', { role: 'organizer' }), person('amy', 'Amy', { role: 'organizer' }), person('sam', 'Sam')],
        sections: [q()],
        votes: [{ option_id: 'q-a', user_id: 'sam' }, { option_id: 'q-b', user_id: 'tim' }],
      })
      const item = computeWaitingOn(s, NOW).byItem.find((i) => i.kind === 'org_tie')!
      expect(item.userIds.sort()).toEqual(['amy', 'tim'])
      expect(item.detail).toBe('Any organizer can do this (2)')
      expect(item.shortTitle).toBe('Tie: choose a winner for Where are we staying?')
      expect(computeWaitingOn(s, NOW).byItem.filter((i) => i.kind === 'org_decide')).toHaveLength(0)
    })
  })

  describe('book (slice 4E)', () => {
    const DECIDED_META = { decided_option_id: 'win', followup_action_id: 'act-book' }
    const realBook = (over: Record<string, unknown> = {}) => ({ id: 'act-book', title: 'Book: Osaka Airbnb', assigned_to: 'sam', deadline_kind: 'fixed', due_date: '2026-12-01', completed_at: null as string | null, section_id: null, ...over })
    const sec = (metadata: Record<string, unknown>) =>
      question('d', 'Where to stay', { status: 'completed', section_type: 'accommodation', metadata: metadata as never, options: [{ id: 'win', title: 'Osaka Airbnb', status: 'available', selections: [] }, { id: 'lose', title: 'Hotel', status: 'available', selections: [] }] })
    const mk = (section: SnapshotSection, actions: TripSnapshot['actions'] = [], bookings?: TripSnapshot['bookings']) =>
      snap({ sections: [section], votes: [{ option_id: 'win', user_id: 'sam' }], actions, bookings, participants: [person('tim', 'Tim', { role: 'organizer' }), person('sam', 'Sam')] })

    it('decided with a real Book to-do: no synthetic org_book; the real one is a normal task for its assignee', () => {
      const s = mk(sec(DECIDED_META), [realBook()])
      expect(kinds(s, 'tim')).toEqual([])
      const sam = computeTodos(s, 'sam', NOW)
      expect(sam.map((t) => [t.kind, t.title, t.group])).toEqual([['task', 'Book: Osaka Airbnb', 'personal']])
      // done real to-do (mark_booked completes it): nothing reappears
      expect(kinds(mk(sec(DECIDED_META), [realBook({ completed_at: '2026-11-15T00:00:00Z' })]), 'tim')).toEqual([])
      expect(kinds(mk(sec(DECIDED_META), [realBook({ completed_at: '2026-11-15T00:00:00Z' })]), 'sam')).toEqual([])
    })

    it('the real to-do deleted (or never created): the synthetic org_book comes back, linking to book:<optionId>', () => {
      for (const s of [mk(sec(DECIDED_META), []), mk(sec({ decided_option_id: 'win' }))]) {
        const t = computeTodos(s, 'tim', NOW)
        expect(t.map((x) => x.kind)).toEqual(['org_book'])
        expect(t[0].link).toBe('?open=book:win')
        expect(t[0].title).toBe('Book: Osaka Airbnb')
      }
    })

    it('decided + booked (legacy status or a live booking): no org_book; cancelled booking brings it back', () => {
      const booked = sec({ decided_option_id: 'win' })
      booked.options = booked.options.map((o) => (o.id === 'win' ? { ...o, status: 'booked' } : o))
      expect(kinds(mk(booked), 'tim')).toEqual([])
      expect(kinds(mk(sec({ decided_option_id: 'win' }), [], [{ option_id: 'win', status: 'reserved' }]), 'tim')).toEqual([])
      expect(kinds(mk(sec({ decided_option_id: 'win' }), [], [{ option_id: 'win', status: 'cancelled' }]), 'tim')).toEqual(['org_book'])
    })

    it('keeps the restraint rules: not on the dates question, not past the trip start, never for own choice', () => {
      expect(kinds(mk({ ...sec({ decided_option_id: 'win' }), title: 'Trip dates' }), 'tim')).toEqual([])
      expect(kinds(mk(sec({ decided_option_id: 'win', decision_shape: 'personal' })), 'tim')).toEqual([])
    })
  })

  it('org_setup is true-in-the-data: invite and first question', () => {
    const lonely = snap({ participants: [person('tim', 'Tim', { role: 'organizer' })], sections: [] })
    const t = computeTodos(lonely, 'tim', NOW)
    expect(t.map((x) => x.id)).toEqual(['org_setup:invite', 'org_setup:question'])
    expect(t.every((x) => x.group === 'organiser')).toBe(true)
  })

  it('creator counts as organiser even without the role', () => {
    const s = snap({ participants: [person('tim', 'Tim')], sections: [] })
    expect(computeTodos(s, 'tim', NOW).map((x) => x.kind)).toContain('org_setup')
  })
})

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------
describe('ordering', () => {
  it('overdue first, then due date, then kind order; organiser group last', () => {
    const s = snap({
      trip: { ...snap().trip, confirmation_deadline: '2026-12-01T12:00:00.000Z', settlement_snapshot: { frozen: true } },
      participants: [person('tim', 'Tim', { role: 'organizer', confirmation_status: 'pending' }), person('sam', 'Sam')],
      sections: [
        question('overdueQ', 'Overdue Q', { vote_deadline: new Date(2026, 10, 1, 12).toISOString() }),
        question('plain', 'Plain Q'),
      ],
      actions: [{ id: 'a', title: 'Do a thing', assigned_to: 'tim', deadline_kind: 'fixed', due_date: '2026-11-20', completed_at: null, section_id: null }],
      settlements: [{ id: 's', from_user_id: 'tim', to_user_id: 'sam', amount: 10, currency: 'GBP', status: 'suggested' }],
    })
    const t = computeTodos(s, 'tim', NOW)
    expect(t.map((x) => x.id)).toEqual([
      'answer:overdueQ', // overdue first
      'task:a', // due 20 Nov
      'rsvp:trip1', // due 1 Dec
      'pay:s', // no deadline: kind order puts pay before answer
      'answer:plain',
      'org_decide:overdueQ',
    ])
    expect(t[0].overdue).toBe(true)
    expect(t[t.length - 1].group).toBe('organiser')
  })

  it('compareTodos is a stable total order for equal items', () => {
    const a = { id: '1', kind: 'task', group: 'personal', userId: 'u', entityId: '1', title: 'A', subtitle: null, actionLabel: '', due: null, overdue: false, link: '' } as const
    expect(compareTodos(a, { ...a, title: 'B' })).toBeLessThan(0)
  })
})

// ---------------------------------------------------------------------------
// The invariant: the count is the same wherever it is computed
// ---------------------------------------------------------------------------
describe('one count everywhere', () => {
  const trips: Record<string, TripSnapshot> = {
    japow: snap({
      sections: [question('q1', 'Where?'), question('q2', 'When?', { vote_deadline: new Date(2026, 10, 12, 12).toISOString() })],
      actions: [{ id: 'a1', title: 'Passports', assigned_to: null, deadline_kind: 'fixed', due_date: '2026-11-10', completed_at: null, section_id: null }],
      checklists: [{ id: 'c1', title: 'Speaker', assigned_to: 'sam', done: false }],
      settlements: [{ id: 's1', from_user_id: 'sam', to_user_id: 'tim', amount: 20, currency: 'GBP', status: 'suggested' }],
    }),
    sicily: snap({
      trip: { ...snap().trip, status: 'trip_completed', start_date: '2025-06-01', end_date: '2025-06-08' },
      balances: { sam: -42.5, chai: 10 },
      sections: [question('q1', 'Old')],
    }),
  }

  for (const [name, s] of Object.entries(trips)) {
    it(`${name}: Today count = waiting-on row = pill`, () => {
      const wo = computeWaitingOn(s, NOW)
      for (const p of s.participants) {
        const direct = computeTodos(s, p.user_id, NOW)
        const row = wo.byPerson.find((x) => x.userId === p.user_id)
        expect(row?.count ?? 0).toBe(direct.length)
        expect(wo.byUser.get(p.user_id) ?? []).toEqual(direct)
        expect(todoCountLabel(direct.length)).toBe(`${direct.length} to-do${direct.length === 1 ? '' : 's'}`)
      }
      expect(wo.totalTodos).toBe(wo.byPerson.reduce((n, p) => n + p.count, 0))
    })
  }
})

describe('computeWaitingOn', () => {
  const s = snap({
    sections: [question('q', 'Where are we staying?', { vote_deadline: new Date(2026, 10, 20, 12).toISOString() })],
    votes: [{ option_id: 'q-a', user_id: 'tim' }],
    actions: [{ id: 'a', title: 'Fill in guest info', assigned_to: null, deadline_kind: 'fixed', due_date: null, completed_at: null, section_id: null, trip_action_completions: [{ user_id: 'tim' }] }],
  })

  it('by person: most to-dos first with names', () => {
    const wo = computeWaitingOn(s, NOW)
    expect(wo.byPerson.map((p) => [p.name, p.count])).toEqual([['Chai', 3], ['Sam', 2]])
  })

  it('by item: who still owes each thing, with done/total', () => {
    const wo = computeWaitingOn(s, NOW)
    const q = wo.byItem.find((i) => i.id === 'answer:q')!
    expect(q.title).toBe('Where are we staying?')
    expect(q.userIds.sort()).toEqual(['chai', 'sam'])
    expect(q).toMatchObject({ done: 1, total: 3 })
    const a = wo.byItem.find((i) => i.id === 'task:a')!
    expect(a).toMatchObject({ done: 1, total: 3 })
    expect(a.userIds.sort()).toEqual(['chai', 'sam'])
  })

  it('is empty when nobody owes anything', () => {
    const wo = computeWaitingOn(snap({ participants: [person('tim', 'Tim', { role: 'organizer' }), person('sam', 'Sam')], sections: [question('q', 'Q')], votes: [{ option_id: 'q-a', user_id: 'tim' }, { option_id: 'q-a', user_id: 'sam' }], checklists: [], }), NOW, { includeOrganiser: false })
    expect(wo.byPerson).toEqual([])
    expect(wo.byItem).toEqual([])
  })
})

describe('copy helpers', () => {
  it('formats money, closes labels and answer-all', () => {
    expect(formatMoney(120, 'GBP')).toBe('£120')
    expect(formatMoney(4698.61, 'GBP')).toBe('£4,698.61')
    expect(closesLabel(new Date(2026, 10, 20, 12).toISOString(), NOW)).toBe('closes Fri')
    expect(closesLabel(new Date(2026, 11, 25, 12).toISOString(), NOW)).toBe('closes Fri 25 Dec')
    expect(closesLabel(new Date(2026, 10, 1).toISOString(), NOW)).toBe('deadline passed')
    expect(answerAllLabel(3)).toBe('Answer all (3) · about 2 min →')
    expect(DEEP_LINKS.todos()).toBe('?open=todos')
    expect(DEEP_LINKS.answerAll()).toBe('?open=answer-all')
  })

  it('canAnswerAll needs two answer to-dos', () => {
    const s = snap({ sections: [question('a', 'A'), question('b', 'B')] })
    expect(canAnswerAll(computeTodos(s, 'sam', NOW))).toBe(true)
    expect(canAnswerAll(computeTodos(snap({ sections: [question('a', 'A')] }), 'sam', NOW))).toBe(false)
  })
})

describe('Ideas bucket and own-choice bookings', () => {
  const ideas = question('ideas', 'Ideas', {
    metadata: { ideas_bucket: true, decision_shape: 'group' },
    vote_deadline: '2026-11-01T00:00:00Z',
    voting_method: 'approval',
  })
  const s = () => snap({ sections: [ideas], votes: [{ option_id: 'ideas-a', user_id: 'sam' }] })

  it('creates no answer, decide, tie or book to-do for anyone, and no setup-question nag count change', () => {
    for (const uid of ['tim', 'sam', 'chai']) {
      const k = kinds(s(), uid).filter((x) => x !== 'org_setup' && x !== 'rsvp')
      expect(k).toEqual([])
    }
  })

  it('a completed Ideas bucket does not produce a Book to-do', () => {
    const done = { ...ideas, status: 'completed', section_type: 'activities', options: [{ id: 'x', title: 'Idea', status: 'booked', selections: [] }] }
    expect(kinds(snap({ sections: [done] }), 'tim').filter((x) => x === 'org_book')).toEqual([])
  })

  it('one booked option of an Own-choice question does not close it for everyone else', () => {
    const own = question('own', 'Flights', {
      metadata: { decision_shape: 'personal' },
      vote_deadline: '2027-01-01T00:00:00Z',
      options: [
        { id: 'own-a', title: 'Mine', status: 'booked', selections: [] },
        { id: 'own-b', title: 'Yours', status: 'available', selections: [] },
      ],
    })
    expect(kinds(snap({ sections: [own] }), 'sam')).toContain('answer')
  })

  it('org_tie action label is "Choose winner"', () => {
    expect(TODO_ACTION_LABEL.org_tie).toBe('Choose winner')
  })
})
