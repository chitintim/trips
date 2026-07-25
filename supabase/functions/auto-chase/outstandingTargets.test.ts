/**
 * Unit tests for outstandingTargets -- the "who still owes this action"
 * predicate used by both the staged deadline-reminder sweep and the test
 * digest entrypoint in index.ts. The headline case is the bug this module
 * fixes: a section-linked action must NOT chase someone who has already
 * voted in that section, even without a manual completion row.
 *
 * Run with: deno test supabase/functions/auto-chase/outstandingTargets.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@1'
import { outstandingTargets } from './outstandingTargets.ts'
import { buildSectionVoters, type SectionVoterIds } from '../_shared/actionCompletion/sectionVoters.ts'

const votersFor = (sectionId: string, userIds: string[]): SectionVoterIds => new Map([[sectionId, new Set(userIds)]])

Deno.test('outstandingTargets: voted user is dropped from a section-linked action, even without a completion row', () => {
  const result = outstandingTargets(['u1', 'u2'], 'sec1', new Set(), votersFor('sec1', ['u1']))
  assertEquals(result, ['u2'])
})

Deno.test('outstandingTargets: manual completion still drops a target with no vote', () => {
  const result = outstandingTargets(['u1', 'u2'], 'sec1', new Set(['u1']), votersFor('sec1', []))
  assertEquals(result, ['u2'])
})

Deno.test('outstandingTargets: both a voter and a manual completion are dropped (derived OR manual)', () => {
  const result = outstandingTargets(['u1', 'u2', 'u3'], 'sec1', new Set(['u1']), votersFor('sec1', ['u2']))
  assertEquals(result, ['u3'])
})

Deno.test('outstandingTargets: unlinked action (no section_id) is unaffected by votes -- manual completion only', () => {
  const result = outstandingTargets(['u1', 'u2'], null, new Set(['u1']), votersFor('sec1', ['u2']))
  assertEquals(result, ['u2'])
})

Deno.test('outstandingTargets: everyone outstanding when neither completed nor voted', () => {
  const result = outstandingTargets(['u1', 'u2'], 'sec1', new Set(), new Map())
  assertEquals(result, ['u1', 'u2'])
})

Deno.test('outstandingTargets: nobody outstanding once every target has voted', () => {
  const result = outstandingTargets(['u1', 'u2'], 'sec1', new Set(), votersFor('sec1', ['u1', 'u2']))
  assertEquals(result, [])
})

Deno.test('outstandingTargets: built from buildSectionVoters (options/votes join), not a hand-rolled map -- end-to-end wiring sanity check', () => {
  const options = [{ id: 'opt1', section_id: 'sec1' }]
  const votes = [{ option_id: 'opt1', user_id: 'u1' }]
  const sectionVoters = buildSectionVoters(options, votes)
  const result = outstandingTargets(['u1', 'u2'], 'sec1', new Set(), sectionVoters)
  assertEquals(result, ['u2'])
})

Deno.test('outstandingTargets: a retracted vote (rebuilt sectionVoters no longer lists the user) makes them outstanding again', () => {
  const beforeRetraction = votersFor('sec1', ['u1'])
  const afterRetraction = votersFor('sec1', [])
  assertEquals(outstandingTargets(['u1'], 'sec1', new Set(), beforeRetraction), [])
  assertEquals(outstandingTargets(['u1'], 'sec1', new Set(), afterRetraction), ['u1'])
})
