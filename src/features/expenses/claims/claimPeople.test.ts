import { describe, expect, it } from 'vitest'
import { peopleOnReceipt, taggedUserIds } from './claimPeople'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'

const person = (id: string): ParticipantWithUser =>
  ({ user_id: id, user: { id, full_name: `Person ${id}`, email: `${id}@x.test` } }) as unknown as ParticipantWithUser

const all = ['a', 'b', 'c', 'd'].map(person)

describe('taggedUserIds / peopleOnReceipt', () => {
  it('no list: everyone in the people list', () => {
    expect([...taggedUserIds({ participant_ids: null, paid_by: 'a' }, all)].sort()).toEqual(['a', 'b', 'c', 'd'])
  })
  it('explicit list: only those, payer not forced in', () => {
    expect([...taggedUserIds({ participant_ids: ['b'], paid_by: 'a' }, all)]).toEqual(['b'])
  })
  it('a claimant outside the list is added (both with and without an explicit list); leftover rows do not count', () => {
    const claims = [{ user_id: 'c', source: 'self' }, { user_id: 'd', source: 'leftover' }]
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
