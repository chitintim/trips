import { describe, expect, it } from 'vitest'
import { computeTodos } from '../../../lib/todos/computeTodos'
import type { SnapshotParticipant, SnapshotSection, TripSnapshot } from '../../../lib/todos/types'
import { hasAnswered } from '../../../lib/answers/answers'
import {
  canSuggestIdea, canSuggestOption, canWithdrawSuggestion, firstNameOf, normalizeSuggestionLink, suggestedByLabel, suggestedById,
  validateSuggestion, SUGGEST_MAX_PER_QUESTION,
} from './suggestOption'

describe('validateSuggestion (mirrors suggest_option)', () => {
  it('needs a title of 1 to 120 characters after trimming', () => {
    expect(validateSuggestion({ title: '   ', link: '' })).toMatch(/title/)
    expect(validateSuggestion({ title: 'x'.repeat(121), link: '' })).toMatch(/120/)
    expect(validateSuggestion({ title: ' Hotel Aurora ', link: '' })).toBeNull()
    expect(validateSuggestion({ title: 'x'.repeat(120), link: '' })).toBeNull()
  })
  it('link is optional and http(s) only', () => {
    expect(validateSuggestion({ title: 'T', link: '' })).toBeNull()
    expect(validateSuggestion({ title: 'T', link: 'https://example.com/a?b=1' })).toBeNull()
    expect(validateSuggestion({ title: 'T', link: 'www.example.com' })).toBeNull()
    for (const bad of ['javascript:alert(1)', 'ftp://x.y', 'two words', 'not a link', 'example']) {
      expect(validateSuggestion({ title: 'T', link: bad })).toMatch(/link/)
    }
  })
  it('normalizes the link the way the server stores it', () => {
    expect(normalizeSuggestionLink(' www.a.com/x ')).toBe('https://www.a.com/x')
    expect(normalizeSuggestionLink('http://a.com')).toBe('http://a.com')
    expect(normalizeSuggestionLink('')).toBeNull()
    expect(normalizeSuggestionLink('javascript:alert(1)')).toBeNull()
  })
})

const section = (over: Record<string, unknown> = {}) => ({
  status: 'in_progress',
  title: 'Where are we staying?',
  metadata: null as unknown,
  options: [{ title: 'A', status: 'available', metadata: null as unknown }, { title: 'B', status: 'available', metadata: null as unknown }],
  ...over,
})
const base = { rpcAvailable: true, userId: 'u1', viewerOut: false, tripFinished: false, canManageTrip: false }

describe('who sees "Suggest an option"', () => {
  it('a participant who is coming, on an open group question', () => {
    expect(canSuggestOption({ ...base, section: section() })).toBe(true)
    expect(canSuggestOption({ ...base, section: section({ metadata: { decision_shape: 'vote' } }) })).toBe(true)
  })
  it('hidden before the migration exists, when signed out, out of the trip, finished, or for organizers', () => {
    expect(canSuggestOption({ ...base, rpcAvailable: false, section: section() })).toBe(false)
    expect(canSuggestOption({ ...base, userId: null, section: section() })).toBe(false)
    expect(canSuggestOption({ ...base, viewerOut: true, section: section() })).toBe(false)
    expect(canSuggestOption({ ...base, tripFinished: true, section: section() })).toBe(false)
    expect(canSuggestOption({ ...base, canManageTrip: true, section: section() })).toBe(false)
  })
  it('hidden on closed questions, Own choice, and date polls', () => {
    expect(canSuggestOption({ ...base, section: section({ status: 'completed' }) })).toBe(false)
    expect(canSuggestOption({ ...base, section: section({ metadata: { decision_shape: 'personal' } }) })).toBe(false)
    expect(canSuggestOption({ ...base, section: section({ title: 'Trip dates' }) })).toBe(false)
    expect(canSuggestOption({ ...base, section: section({ options: [{ title: 'Week 1', status: 'available', metadata: { date_range: { start: '2027-01-01' } } }] }) })).toBe(false)
  })
  it('hidden once the person hit the per-question limit', () => {
    const mine = Array.from({ length: SUGGEST_MAX_PER_QUESTION }, (_, i) => ({ title: `S${i}`, status: 'available', metadata: { suggested_by: 'u1' } }))
    expect(canSuggestOption({ ...base, section: section({ options: mine }) })).toBe(false)
    expect(canSuggestOption({ ...base, section: section({ options: mine.slice(1) }) })).toBe(true)
  })
  it('the Ideas bucket is a normal Choose-any question, so participants can suggest into it', () => {
    expect(canSuggestOption({ ...base, section: section({ title: 'Ideas', metadata: { decision_shape: 'vote', ideas_bucket: true } }) })).toBe(true)
  })
  it('ideas from the Add flow: same people, no question needed', () => {
    expect(canSuggestIdea(base)).toBe(true)
    expect(canSuggestIdea({ ...base, canManageTrip: true })).toBe(false)
    expect(canSuggestIdea({ ...base, rpcAvailable: false })).toBe(false)
    expect(canSuggestIdea({ ...base, tripFinished: true })).toBe(false)
    expect(canSuggestIdea({ ...base, viewerOut: true })).toBe(false)
  })
})

describe('Suggested by label', () => {
  const people = [
    { user_id: 'a', user: { first_name: 'Alex', full_name: 'Alex Kim' } },
    { user_id: 'b', user: { first_name: null, full_name: 'Bo Lee Jr', email: 'bo@x.com' } },
    { user_id: 'c', user: { first_name: null, full_name: null, email: 'cam@x.com' } },
  ]
  it('uses the first name, then the full name, then the email, then "someone"', () => {
    expect(suggestedByLabel({ metadata: { suggested_by: 'a' } }, people, 'z')).toBe('Suggested by Alex')
    expect(suggestedByLabel({ metadata: { suggested_by: 'b' } }, people, 'z')).toBe('Suggested by Bo')
    expect(suggestedByLabel({ metadata: { suggested_by: 'c' } }, people, 'z')).toBe('Suggested by cam')
    expect(suggestedByLabel({ metadata: { suggested_by: 'gone' } }, people, 'z')).toBe('Suggested by someone')
    expect(firstNameOf(undefined)).toBe('someone')
  })
  it('says "you" to the suggester and nothing for ordinary options', () => {
    expect(suggestedByLabel({ metadata: { suggested_by: 'a' } }, people, 'a')).toBe('Suggested by you')
    expect(suggestedByLabel({ metadata: null }, people, 'a')).toBeNull()
    expect(suggestedByLabel({ metadata: { source_url: 'https://x.y' } }, people, 'a')).toBeNull()
    expect(suggestedById({ metadata: ['suggested_by'] })).toBeNull()
  })
})

describe('Withdraw', () => {
  const option = { metadata: { suggested_by: 'a' }, status: 'available', locked: false }
  const ok = { option, userId: 'a', questionOpen: true, tripFinished: false, answered: false }
  it('only the suggester, while open, untouched and unanswered', () => {
    expect(canWithdrawSuggestion(ok)).toBe(true)
    expect(canWithdrawSuggestion({ ...ok, userId: 'b' })).toBe(false)
    expect(canWithdrawSuggestion({ ...ok, userId: null })).toBe(false)
    expect(canWithdrawSuggestion({ ...ok, questionOpen: false })).toBe(false)
    expect(canWithdrawSuggestion({ ...ok, tripFinished: true })).toBe(false)
    expect(canWithdrawSuggestion({ ...ok, answered: true })).toBe(false)
    expect(canWithdrawSuggestion({ ...ok, option: { ...option, status: 'booked' } })).toBe(false)
    expect(canWithdrawSuggestion({ ...ok, option: { ...option, locked: true } })).toBe(false)
    expect(canWithdrawSuggestion({ ...ok, option: { metadata: null, status: 'available' } })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// To-dos / answers engine: a suggested option never reopens "answered" or adds to-dos
// ---------------------------------------------------------------------------
const person = (id: string, name: string, over: Partial<SnapshotParticipant> = {}): SnapshotParticipant => ({
  user_id: id, role: 'participant', active: true, confirmation_status: 'confirmed', user: { full_name: `${name} Smith`, first_name: name }, ...over,
})
const q = (method: string, extra: Partial<SnapshotSection> = {}): SnapshotSection => ({
  id: 'q', title: 'Stay', status: 'in_progress', vote_deadline: null, voting_method: method, metadata: null,
  options: [{ id: 'q-a', title: 'A', status: 'available', selections: [] }, { id: 'q-b', title: 'B', status: 'available', selections: [] }],
  ...extra,
})
const snap = (section: SnapshotSection, votes: TripSnapshot['votes']): TripSnapshot => ({
  trip: { id: 't', name: 'Trip', status: 'confirming_participants', start_date: '2027-02-06', end_date: '2027-02-13', confirmation_enabled: true, confirmation_deadline: null, base_currency: 'GBP', created_by: 'org' },
  participants: [person('org', 'Org', { role: 'organizer' }), person('sam', 'Sam'), person('kim', 'Kim')],
  sections: [section], votes, actions: [], checklists: [], expenses: [], settlements: [], travelEvents: [],
})
const withSuggestion = (s: SnapshotSection): SnapshotSection => ({
  ...s, options: [...s.options, { id: 'q-s', title: 'Suggested', status: 'available', selections: [], metadata: { suggested_by: 'kim' } } as SnapshotSection['options'][number]],
})
const NOW = new Date(2026, 10, 16, 12, 0, 0)

describe('a newly suggested option does not change anyone\'s to-dos', () => {
  for (const method of ['single', 'approval', 'ranked']) {
    it(`${method}: answered people stay answered; nobody gets a new to-do; organizer gets no new kind`, () => {
      const votes = [{ option_id: 'q-a', user_id: 'sam', rank: method === 'ranked' ? 1 : null }, { option_id: 'q-a', user_id: 'org', rank: method === 'ranked' ? 1 : null }]
      const before = snap(q(method), votes)
      const after = snap(withSuggestion(q(method)), votes)
      for (const uid of ['org', 'sam', 'kim']) {
        expect(computeTodos(after, uid, NOW).map((t) => t.kind)).toEqual(computeTodos(before, uid, NOW).map((t) => t.kind))
      }
      expect(computeTodos(after, 'sam', NOW)).toEqual([])
      expect(computeTodos(after, 'kim', NOW).map((t) => t.kind)).toEqual(['answer']) // unchanged: Kim still owes an answer
      expect(hasAnswered({ id: 'q', status: 'in_progress', metadata: null, options: after.sections[0].options as never }, 'sam', { votes: votes as never })).toBe(true)
    })
  }
})

describe('suggestedSourceUrl', () => {
  it('reads the stored link, null otherwise', async () => {
    const { suggestedSourceUrl } = await import('./suggestOption')
    expect(suggestedSourceUrl({ metadata: { source_url: 'https://a.com/x' } })).toBe('https://a.com/x')
    expect(suggestedSourceUrl({ metadata: { suggested_by: 'u' } })).toBeNull()
    expect(suggestedSourceUrl({ metadata: null })).toBeNull()
  })
})
