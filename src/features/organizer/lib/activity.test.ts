import { describe, it, expect } from 'vitest'
import { describeNotificationKind } from './activity'

describe('describeNotificationKind', () => {
  it('returns known labels/icons for auto-chase kinds', () => {
    expect(describeNotificationKind('overdue_action')).toEqual({ icon: '🚨', label: 'Overdue action' })
    expect(describeNotificationKind('action_due_7d').label).toBe('Action due in 7 days')
    expect(describeNotificationKind('action_due_1d').label).toBe('Action due tomorrow')
  })

  it('falls back to a humanized label for unknown kinds instead of disappearing', () => {
    expect(describeNotificationKind('some_future_kind')).toEqual({ icon: '✉️', label: 'some future kind' })
  })
})
