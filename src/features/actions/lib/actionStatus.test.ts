import { describe, it, expect } from 'vitest'
import {
  resolveDueDate,
  daysUntilDue,
  isOverdue,
  actionUrgency,
  countdownBadgeVariant,
  isActionCompleteForUser,
  isActionOpenForUser,
  openActionCountForUser,
  isGroupComplete,
  groupCompletedUserIds,
  buildSectionVoters,
  countdownLabel,
  type ActionRow,
  type ActionWithCompletions,
  type SectionVoterIds,
} from './actionStatus'

/** Local-date `YYYY-MM-DD` string N days from now, matching daysUntil's local-midnight semantics. */
function localDateOffset(days: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function makeAction(overrides: Partial<ActionRow> = {}): ActionRow {
  return {
    id: 'a1',
    trip_id: 't1',
    title: 'Book flights',
    notes: null,
    created_by: 'u1',
    assigned_to: null,
    deadline_kind: 'fixed',
    due_date: null,
    completed_at: null,
    completed_by: null,
    section_id: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('resolveDueDate', () => {
  it('returns due_date for fixed deadlines', () => {
    const action = makeAction({ deadline_kind: 'fixed', due_date: '2026-07-20' })
    expect(resolveDueDate(action, { start_date: '2026-08-01' })).toBe('2026-07-20')
  })

  it('returns trip start_date for before_trip deadlines', () => {
    const action = makeAction({ deadline_kind: 'before_trip', due_date: null })
    expect(resolveDueDate(action, { start_date: '2026-08-01' })).toBe('2026-08-01')
  })

  it('is null-safe when trip is null/undefined for before_trip', () => {
    const action = makeAction({ deadline_kind: 'before_trip' })
    expect(resolveDueDate(action, null)).toBeNull()
    expect(resolveDueDate(action, undefined)).toBeNull()
  })

  it('is null-safe when trip.start_date is null', () => {
    const action = makeAction({ deadline_kind: 'before_trip' })
    expect(resolveDueDate(action, { start_date: null })).toBeNull()
  })

  it('is null when a fixed action has no due_date', () => {
    const action = makeAction({ deadline_kind: 'fixed', due_date: null })
    expect(resolveDueDate(action, undefined)).toBeNull()
  })
})

describe('daysUntilDue', () => {
  it('returns null when unresolvable', () => {
    const action = makeAction({ deadline_kind: 'before_trip' })
    expect(daysUntilDue(action, undefined)).toBeNull()
  })

  it('computes days for a resolvable fixed date', () => {
    const iso = localDateOffset(3)
    const action = makeAction({ deadline_kind: 'fixed', due_date: iso })
    expect(daysUntilDue(action, undefined)).toBeGreaterThanOrEqual(2)
  })
})

describe('isOverdue', () => {
  it('due today is not overdue', () => {
    const today = localDateOffset(0)
    const action = makeAction({ deadline_kind: 'fixed', due_date: today })
    expect(isOverdue(action, undefined)).toBe(false)
  })

  it('due yesterday is overdue', () => {
    const yesterday = localDateOffset(-1)
    const action = makeAction({ deadline_kind: 'fixed', due_date: yesterday })
    expect(isOverdue(action, undefined)).toBe(true)
  })

  it('due tomorrow is not overdue', () => {
    const tomorrow = localDateOffset(1)
    const action = makeAction({ deadline_kind: 'fixed', due_date: tomorrow })
    expect(isOverdue(action, undefined)).toBe(false)
  })

  it('is false (not throwing) when unresolvable', () => {
    const action = makeAction({ deadline_kind: 'before_trip' })
    expect(isOverdue(action, null)).toBe(false)
  })
})

describe('actionUrgency / countdownBadgeVariant', () => {
  it('is null / neutral when the due date is unresolvable', () => {
    const action = makeAction({ deadline_kind: 'before_trip' })
    expect(actionUrgency(action, null)).toBeNull()
    expect(countdownBadgeVariant(action, null)).toBe('neutral')
  })

  it('is red (error) when overdue', () => {
    const action = makeAction({ deadline_kind: 'fixed', due_date: localDateOffset(-1) })
    expect(actionUrgency(action, undefined)).toBe('overdue')
    expect(countdownBadgeVariant(action, undefined)).toBe('error')
  })

  it('is red (error) at ≤2 days, including due today', () => {
    for (const offset of [0, 1, 2]) {
      const action = makeAction({ deadline_kind: 'fixed', due_date: localDateOffset(offset) })
      expect(actionUrgency(action, undefined)).toBe('urgent')
      expect(countdownBadgeVariant(action, undefined)).toBe('error')
    }
  })

  it('is amber (warning) at 3–7 days', () => {
    for (const offset of [3, 7]) {
      const action = makeAction({ deadline_kind: 'fixed', due_date: localDateOffset(offset) })
      expect(actionUrgency(action, undefined)).toBe('soon')
      expect(countdownBadgeVariant(action, undefined)).toBe('warning')
    }
  })

  it('is neutral beyond 7 days', () => {
    const action = makeAction({ deadline_kind: 'fixed', due_date: localDateOffset(8) })
    expect(actionUrgency(action, undefined)).toBe('normal')
    expect(countdownBadgeVariant(action, undefined)).toBe('neutral')
  })

  it('counts a before_trip action down to the trip start date', () => {
    const action = makeAction({ deadline_kind: 'before_trip', due_date: null })
    expect(countdownBadgeVariant(action, { start_date: localDateOffset(5) })).toBe('warning')
    expect(countdownBadgeVariant(action, { start_date: localDateOffset(30) })).toBe('neutral')
  })
})

describe('isActionOpenForUser / openActionCountForUser', () => {
  const completions = (ids: string[]) => ids.map((user_id) => ({ user_id, completed_at: '2026-01-05T00:00:00Z' }))

  it('individual action assigned to me: open until completed', () => {
    const open = makeAction({ assigned_to: 'me', completed_at: null }) as ActionWithCompletions
    const done = makeAction({ assigned_to: 'me', completed_at: '2026-01-05T00:00:00Z' }) as ActionWithCompletions
    expect(isActionOpenForUser(open, 'me')).toBe(true)
    expect(isActionOpenForUser(done, 'me')).toBe(false)
  })

  it('individual action assigned to someone else is never mine', () => {
    const theirs = makeAction({ assigned_to: 'them', completed_at: null }) as ActionWithCompletions
    expect(isActionOpenForUser(theirs, 'me')).toBe(false)
  })

  it('group action: open while I have not confirmed it, regardless of others', () => {
    const unconfirmed: ActionWithCompletions = { ...makeAction({ assigned_to: null }), trip_action_completions: completions(['them']) }
    const confirmed: ActionWithCompletions = { ...makeAction({ assigned_to: null }), trip_action_completions: completions(['me']) }
    expect(isActionOpenForUser(unconfirmed, 'me')).toBe(true)
    expect(isActionOpenForUser(confirmed, 'me')).toBe(false)
  })

  it('openActionCountForUser counts only my open actions and is 0 without a user', () => {
    const actions: ActionWithCompletions[] = [
      { ...makeAction({ id: 'a1', assigned_to: 'me', completed_at: null }), trip_action_completions: [] },
      { ...makeAction({ id: 'a2', assigned_to: 'me', completed_at: '2026-01-05T00:00:00Z' }), trip_action_completions: [] },
      { ...makeAction({ id: 'a3', assigned_to: 'them', completed_at: null }), trip_action_completions: [] },
      { ...makeAction({ id: 'a4', assigned_to: null }), trip_action_completions: completions(['them']) },
      { ...makeAction({ id: 'a5', assigned_to: null }), trip_action_completions: completions(['me', 'them']) },
    ]
    expect(openActionCountForUser(actions, 'me')).toBe(2) // a1 + a4
    expect(openActionCountForUser(actions, undefined)).toBe(0)
    expect(openActionCountForUser(undefined, 'me')).toBe(0)
  })
})

describe('isActionCompleteForUser', () => {
  it('individual action: complete iff completed_at is set', () => {
    const done = makeAction({ assigned_to: 'u2', completed_at: '2026-01-05T00:00:00Z' }) as ActionWithCompletions
    const notDone = makeAction({ assigned_to: 'u2', completed_at: null }) as ActionWithCompletions
    expect(isActionCompleteForUser(done, 'u2')).toBe(true)
    expect(isActionCompleteForUser(notDone, 'u2')).toBe(false)
  })

  it('group action: complete iff a matching completion row exists for the user', () => {
    const action: ActionWithCompletions = {
      ...makeAction({ assigned_to: null }),
      trip_action_completions: [{ user_id: 'u2', completed_at: '2026-01-05T00:00:00Z' }],
    }
    expect(isActionCompleteForUser(action, 'u2')).toBe(true)
    expect(isActionCompleteForUser(action, 'u3')).toBe(false)
  })

  it('group action with no completions array does not throw', () => {
    const action: ActionWithCompletions = makeAction({ assigned_to: null })
    expect(isActionCompleteForUser(action, 'u2')).toBe(false)
  })
})

describe('isGroupComplete', () => {
  it('true when every active participant has a completion row', () => {
    const action: ActionWithCompletions = {
      ...makeAction({ assigned_to: null }),
      trip_action_completions: [
        { user_id: 'u1', completed_at: '2026-01-01T00:00:00Z' },
        { user_id: 'u2', completed_at: '2026-01-02T00:00:00Z' },
      ],
    }
    expect(isGroupComplete(action, ['u1', 'u2'])).toBe(true)
  })

  it('false when an active participant is missing a completion row', () => {
    const action: ActionWithCompletions = {
      ...makeAction({ assigned_to: null }),
      trip_action_completions: [{ user_id: 'u1', completed_at: '2026-01-01T00:00:00Z' }],
    }
    expect(isGroupComplete(action, ['u1', 'u2'])).toBe(false)
  })

  it('ignores completion rows / lack thereof for inactive (removed) participants', () => {
    const action: ActionWithCompletions = {
      ...makeAction({ assigned_to: null }),
      trip_action_completions: [
        { user_id: 'u1', completed_at: '2026-01-01T00:00:00Z' },
        { user_id: 'u2', completed_at: '2026-01-02T00:00:00Z' },
      ],
    }
    // u2 has left the trip and is no longer in the active list; u3 never
    // completed and also isn't active — neither should block completeness.
    expect(isGroupComplete(action, ['u1'])).toBe(true)
  })

  it('false for an empty active-participant list (participants still loading, not vacuously complete)', () => {
    const action: ActionWithCompletions = makeAction({ assigned_to: null })
    expect(isGroupComplete(action, [])).toBe(false)
  })
})

describe('countdownLabel', () => {
  it('formats a fixed due-in-N-days action', () => {
    const iso = localDateOffset(3)
    const action = makeAction({ deadline_kind: 'fixed', due_date: iso })
    expect(countdownLabel(action, undefined)).toMatch(/^\d+ days? left$/)
  })

  it('formats "Due today"', () => {
    const today = localDateOffset(0)
    const action = makeAction({ deadline_kind: 'fixed', due_date: today })
    expect(countdownLabel(action, undefined)).toBe('Due today')
  })

  it('formats overdue', () => {
    const yesterday = localDateOffset(-1)
    const action = makeAction({ deadline_kind: 'fixed', due_date: yesterday })
    expect(countdownLabel(action, undefined)).toBe('Overdue by 1 day')
  })

  it('pluralizes overdue days', () => {
    const action = makeAction({ deadline_kind: 'fixed', due_date: localDateOffset(-3) })
    expect(countdownLabel(action, undefined)).toBe('Overdue by 3 days')
  })

  it('prefixes before_trip deadlines', () => {
    const action = makeAction({ deadline_kind: 'before_trip' })
    const iso = localDateOffset(5)
    expect(countdownLabel(action, { start_date: iso })).toMatch(/^Before trip · \d+ days? left$/)
  })

  it('has sensible copy for an unresolvable before_trip action', () => {
    const action = makeAction({ deadline_kind: 'before_trip' })
    expect(countdownLabel(action, undefined)).toBe('Before trip')
  })

  it('has sensible copy for a fixed action with no due date', () => {
    const action = makeAction({ deadline_kind: 'fixed', due_date: null })
    expect(countdownLabel(action, undefined)).toBe('No due date')
  })
})

describe('buildSectionVoters', () => {
  it('maps section ids to the users who voted on any of that section option', () => {
    const options = [
      { id: 'opt1', section_id: 'sec1' },
      { id: 'opt2', section_id: 'sec1' },
      { id: 'opt3', section_id: 'sec2' },
    ]
    const votes = [
      { option_id: 'opt1', user_id: 'u1' },
      { option_id: 'opt2', user_id: 'u2' },
      { option_id: 'opt3', user_id: 'u1' },
    ]
    const voters = buildSectionVoters(options, votes)
    expect(voters.get('sec1')).toEqual(new Set(['u1', 'u2']))
    expect(voters.get('sec2')).toEqual(new Set(['u1']))
  })

  it('ignores votes for options with no known section (stale/deleted option)', () => {
    const voters = buildSectionVoters([], [{ option_id: 'ghost', user_id: 'u1' }])
    expect(voters.size).toBe(0)
  })
})

describe('derived (vote-based) completion', () => {
  const votersFor = (sectionId: string, userIds: string[]): SectionVoterIds => new Map([[sectionId, new Set(userIds)]])

  describe('isActionCompleteForUser', () => {
    it('individual action linked to a section: complete once the assignee has voted, even with completed_at unset', () => {
      const action = makeAction({ assigned_to: 'u1', completed_at: null, section_id: 'sec1' }) as ActionWithCompletions
      expect(isActionCompleteForUser(action, 'u1', votersFor('sec1', ['u1']))).toBe(true)
    })

    it('individual action linked to a section: still incomplete when the assignee has not voted', () => {
      const action = makeAction({ assigned_to: 'u1', completed_at: null, section_id: 'sec1' }) as ActionWithCompletions
      expect(isActionCompleteForUser(action, 'u1', votersFor('sec1', ['someoneElse']))).toBe(false)
    })

    it('group action linked to a section: complete for a user the moment they vote, without a completion row', () => {
      const action: ActionWithCompletions = { ...makeAction({ assigned_to: null, section_id: 'sec1' }), trip_action_completions: [] }
      expect(isActionCompleteForUser(action, 'u2', votersFor('sec1', ['u2']))).toBe(true)
    })

    it('a retracted vote (no longer in sectionVoters) reverts a section-linked action to incomplete', () => {
      const action: ActionWithCompletions = { ...makeAction({ assigned_to: null, section_id: 'sec1' }), trip_action_completions: [] }
      // Freshly rebuilt sectionVoters (as it would be after the vote row is deleted) no longer lists u2.
      const afterRetraction = votersFor('sec1', [])
      expect(isActionCompleteForUser(action, 'u2', afterRetraction)).toBe(false)
    })

    it('manual completion still wins even without a matching vote (derived OR manual = complete)', () => {
      const action: ActionWithCompletions = {
        ...makeAction({ assigned_to: null, section_id: 'sec1' }),
        trip_action_completions: [{ user_id: 'u2', completed_at: '2026-01-05T00:00:00Z' }],
      }
      expect(isActionCompleteForUser(action, 'u2', votersFor('sec1', []))).toBe(true)
    })

    it('an action with no section_id is unaffected by votes (unchanged manual-only behaviour)', () => {
      const action: ActionWithCompletions = { ...makeAction({ assigned_to: null, section_id: null }), trip_action_completions: [] }
      expect(isActionCompleteForUser(action, 'u2', votersFor('sec1', ['u2']))).toBe(false)
    })

    it('is unaffected by votes when no sectionVoters map is supplied at all', () => {
      const action = makeAction({ assigned_to: 'u1', completed_at: null, section_id: 'sec1' }) as ActionWithCompletions
      expect(isActionCompleteForUser(action, 'u1')).toBe(false)
    })
  })

  describe('groupCompletedUserIds / isGroupComplete', () => {
    it('folds voters for the linked section into the completed-ids set alongside explicit completion rows', () => {
      const action: ActionWithCompletions = {
        ...makeAction({ assigned_to: null, section_id: 'sec1' }),
        trip_action_completions: [{ user_id: 'u1', completed_at: '2026-01-01T00:00:00Z' }],
      }
      const ids = groupCompletedUserIds(action, votersFor('sec1', ['u2']))
      expect(ids).toEqual(new Set(['u1', 'u2']))
    })

    it('isGroupComplete is satisfied once every active participant has either voted or ticked manually', () => {
      const action: ActionWithCompletions = {
        ...makeAction({ assigned_to: null, section_id: 'sec1' }),
        trip_action_completions: [{ user_id: 'u1', completed_at: '2026-01-01T00:00:00Z' }],
      }
      expect(isGroupComplete(action, ['u1', 'u2'], votersFor('sec1', ['u2']))).toBe(true)
      expect(isGroupComplete(action, ['u1', 'u2'], votersFor('sec1', []))).toBe(false)
    })
  })

  describe('isActionOpenForUser', () => {
    it('a section-linked individual action drops out of "open" once the assignee votes', () => {
      const action = makeAction({ assigned_to: 'me', completed_at: null, section_id: 'sec1' }) as ActionWithCompletions
      expect(isActionOpenForUser(action, 'me', votersFor('sec1', []))).toBe(true)
      expect(isActionOpenForUser(action, 'me', votersFor('sec1', ['me']))).toBe(false)
    })

    it('openActionCountForUser reflects derived completion too', () => {
      const actions: ActionWithCompletions[] = [
        { ...makeAction({ id: 'a1', assigned_to: null, section_id: 'sec1' }), trip_action_completions: [] },
        { ...makeAction({ id: 'a2', assigned_to: 'me', completed_at: '2026-01-05T00:00:00Z' }), trip_action_completions: [] },
      ]
      expect(openActionCountForUser(actions, 'me', votersFor('sec1', []))).toBe(1)
      expect(openActionCountForUser(actions, 'me', votersFor('sec1', ['me']))).toBe(0)
    })
  })
})
