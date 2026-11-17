import { describe, expect, it } from 'vitest'
import { peopleOnReceipt, taggedUserIds } from './claimPeople'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'

const person = (id: string): ParticipantWithUser =>
  ({ user_id: id, user: { id, full_name: `Person ${id}`, email: `${id}@x.test` } }) as unknown as ParticipantWithUser

const all = ['a', 'b', 'c', 'd'].map(person)

describe('peopleOnReceipt labels', () => {
  const named = (id: string, full_name: string): ParticipantWithUser => ({ user_id: id, user: { id, full_name, email: `${id}@x.test` } }) as unknown as ParticipantWithUser
  it('tells same-first-name people apart without cutting words', () => {
    const ppl = peopleOnReceipt({ participant_ids: null, paid_by: 'a' }, [named('a', 'Tim (Test)'), named('b', 'Tim Lam'), named('c', 'Tim Tran'), named('d', 'Sam')])
    expect(ppl.map((p) => p.label)).toEqual(['Tim (Test)', 'Tim L.', 'Tim T.', 'Sam'])
    expect(ppl[1].fullName).toBe('Tim Lam')
  })
})

describe('taggedUserIds / peopleOnReceipt', () => {
  it('no list: everyone in the people list', () => {
    expect([...taggedUserIds({ participant_ids: null, paid_by: 'a' }, all)].sort()).toEqual(['a', 'b', 'c', 'd'])
  })
  it('explicit list: only those, payer not forced in', () => {
    expect([...taggedUserIds({ participant_ids: ['b'], paid_by: 'a' }, all)]).toEqual(['b'])
  })
  it('a claimant outside the list is added (both with and without an explicit list); a row that only carries a leftover share does not count', () => {
    const claims = [{ user_id: 'c', source: 'self', quantity_claimed: 1 }, { user_id: 'd', source: 'leftover', quantity_claimed: 0.33, leftover_quantity: 0.33 }, { user_id: 'b', source: 'self', quantity_claimed: 1.33, leftover_quantity: 0.33 }]
    expect(peopleOnReceipt({ participant_ids: ['b'], paid_by: 'a' }, all, claims).map((p) => p.id)).toEqual(['b', 'c'])
    expect(peopleOnReceipt({ participant_ids: null, paid_by: 'a' }, all.slice(0, 2), claims).map((p) => p.id)).toEqual(['a', 'b']) // claimant c has no row in the people list, so cannot be shown
  })
  it('the payer is added when the people list (an in-scope subset) left them out and there is no explicit list', () => {
    const inScope = [person('b'), person('c')]
    const ppl = peopleOnReceipt({ participant_ids: null, paid_by: 'a' }, [...inScope, person('a')])
    expect(ppl.map((p) => p.id).sort()).toEqual(['a', 'b', 'c'])
    expect([...taggedUserIds({ participant_ids: null, paid_by: 'a' }, inScope)].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('the shared rule (same as the to-dos and the database)', () => {
  const rsvp = (id: string, st: string) => ({ user_id: id, confirmation_status: st, user: { id, full_name: id, email: `${id}@x.test` } }) as unknown as ParticipantWithUser
  const crew = [rsvp('a', 'confirmed'), rsvp('b', 'confirmed'), rsvp('c', 'declined'), rsvp('d', 'invited')]
  const ex = { participant_ids: null, paid_by: 'a' }
  it('declined / unconfirmed people are dropped only when RSVP tracking is on', () => {
    expect(peopleOnReceipt(ex, crew).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(peopleOnReceipt(ex, crew, [], { confirmationEnabled: true }).map((p) => p.id)).toEqual(['a', 'b'])
  })
  it('"I wasn\'t there" takes someone off (not the payer, not someone holding their own claim)', () => {
    const responses = [{ user_id: 'b', response: 'not_there' }, { user_id: 'a', response: 'not_there' }]
    expect(peopleOnReceipt(ex, crew, [], { responses }).map((p) => p.id)).toEqual(['a', 'c', 'd'])
    expect(peopleOnReceipt(ex, crew, [{ user_id: 'b', source: 'self', quantity_claimed: 1 }], { responses }).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

