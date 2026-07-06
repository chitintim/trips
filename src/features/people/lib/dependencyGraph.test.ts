import { describe, it, expect } from 'vitest'
import { buildDependencyGraph, getTopKeystone } from './dependencyGraph'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'

function participant(overrides: Partial<ParticipantWithUser> & { user_id: string }): ParticipantWithUser {
  return {
    trip_id: 'trip-1',
    role: 'participant',
    active: true,
    confirmation_status: 'conditional',
    confirmation_note: null,
    confirmed_at: null,
    conditional_type: 'users',
    conditional_date: null,
    conditional_user_ids: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    waitlist_offer_expires_at: null,
    user: { id: overrides.user_id, full_name: overrides.user_id, email: `${overrides.user_id}@example.com` } as ParticipantWithUser['user'],
    ...overrides,
  } as ParticipantWithUser
}

describe('buildDependencyGraph', () => {
  it('returns no waiting nodes when nobody has a users/both conditional', () => {
    const participants = [
      participant({ user_id: 'a', confirmation_status: 'confirmed', conditional_type: 'none' }),
      participant({ user_id: 'b', confirmation_status: 'pending', conditional_type: 'none' }),
    ]
    const graph = buildDependencyGraph(participants)
    expect(graph.edges).toHaveLength(0)
    expect(graph.keystones).toHaveLength(0)
  })

  it('builds a direct edge for a simple one-hop dependency', () => {
    const participants = [
      participant({ user_id: 'a', conditional_type: 'users', conditional_user_ids: ['b'] }),
      participant({ user_id: 'b', confirmation_status: 'pending', conditional_type: 'none' }),
    ]
    const graph = buildDependencyGraph(participants)
    expect(graph.edges).toEqual([{ from: 'a', to: 'b' }])
    expect(graph.nodes.get('a')?.dependsOn).toEqual(['b'])
    expect(graph.nodes.get('a')?.inCycle).toBe(false)
  })

  it('computes transitive closure across a chain', () => {
    // a waits on b, b waits on c -> a's transitive deps = [b, c]
    const participants = [
      participant({ user_id: 'a', conditional_type: 'users', conditional_user_ids: ['b'] }),
      participant({ user_id: 'b', conditional_type: 'users', conditional_user_ids: ['c'] }),
      participant({ user_id: 'c', confirmation_status: 'pending', conditional_type: 'none' }),
    ]
    const graph = buildDependencyGraph(participants)
    const aNode = graph.nodes.get('a')!
    expect(aNode.transitiveDependsOn.sort()).toEqual(['b', 'c'])
  })

  it('detects a cycle without infinite-looping', () => {
    // a waits on b, b waits on a (circular)
    const participants = [
      participant({ user_id: 'a', conditional_type: 'users', conditional_user_ids: ['b'] }),
      participant({ user_id: 'b', conditional_type: 'users', conditional_user_ids: ['a'] }),
    ]
    const graph = buildDependencyGraph(participants)
    expect(graph.nodes.get('a')?.inCycle).toBe(true)
    expect(graph.nodes.get('b')?.inCycle).toBe(true)
  })

  it('ranks the keystone by transitive unlock count', () => {
    // b and c both wait on a directly; d waits on c (so d is transitively unlocked by a too)
    const participants = [
      participant({ user_id: 'a', confirmation_status: 'pending', conditional_type: 'none' }),
      participant({ user_id: 'b', conditional_type: 'users', conditional_user_ids: ['a'] }),
      participant({ user_id: 'c', conditional_type: 'users', conditional_user_ids: ['a'] }),
      participant({ user_id: 'd', conditional_type: 'users', conditional_user_ids: ['c'] }),
    ]
    const graph = buildDependencyGraph(participants)
    const top = getTopKeystone(graph)
    expect(top?.userId).toBe('a')
    expect(top?.unlocksCount).toBe(3) // b, c, d all ultimately depend on a
  })

  it('does not count already-confirmed people as keystones', () => {
    const participants = [
      participant({ user_id: 'a', confirmation_status: 'confirmed', conditional_type: 'none' }),
      participant({ user_id: 'b', conditional_type: 'users', conditional_user_ids: ['a'] }),
    ]
    const graph = buildDependencyGraph(participants)
    expect(graph.keystones).toHaveLength(0)
  })

  it('ignores pure date conditionals (no user dependency)', () => {
    const participants = [
      participant({ user_id: 'a', conditional_type: 'date', conditional_date: '2027-01-01', conditional_user_ids: null }),
    ]
    const graph = buildDependencyGraph(participants)
    expect(graph.nodes.get('a')?.isWaiting).toBe(false)
    expect(graph.edges).toHaveLength(0)
  })
})
