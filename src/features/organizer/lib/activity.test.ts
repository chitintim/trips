import { describe, it, expect } from 'vitest'
import { describeNotificationKind, renderActivity } from './activity'

describe('describeNotificationKind', () => {
  it('returns known labels/icons for auto-chase kinds', () => {
    expect(describeNotificationKind('overdue_action')).toEqual({ icon: '🚨', label: 'Overdue to-do' })
    expect(describeNotificationKind('action_due_7d').label).toBe('To-do due in 7 days')
    expect(describeNotificationKind('action_due_1d').label).toBe('To-do due tomorrow')
  })

  it('renders approved wording for the question and reset verbs', () => {
    const e = (verb: string, label: string) => ({ verb, entity: { label }, actor: null }) as never
    expect(renderActivity(e('vote_cast', 'Where to stay'), 'Sam').text).toBe('Sam answered "Where to stay"')
    expect(renderActivity(e('decision_reopened', 'Where to stay'), 'Sam').text).toBe('Sam reopened the question "Where to stay"')
    expect(renderActivity(e('confirmations_reset', '3'), 'Sam').text).toBe('Sam reset replies to Are you coming? (3 cleared)')
  })

  it('falls back to a humanized label for unknown kinds instead of disappearing', () => {
    expect(describeNotificationKind('some_future_kind')).toEqual({ icon: '✉️', label: 'some future kind' })
  })
})
