import { describe, it, expect } from 'vitest'
import {
  resolveDueDate,
  daysUntilDue,
  isOverdue,
  isActionCompleteForUser,
  isGroupComplete,
  countdownLabel,
  type ActionRow,
  type ActionWithCompletions,
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
    expect(countdownLabel(action, undefined)).toBe('1 day overdue')
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
