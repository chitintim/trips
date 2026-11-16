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
    expect(renderActivity(e('question_deleted', 'Where to stay'), 'Sam').text).toBe('Sam deleted the question "Where to stay"')
    expect(renderActivity(e('confirmations_reset', '3'), 'Sam').text).toBe('Sam reset replies to Are you coming? (3 cleared)')
  })

  it('falls back to a humanized label for unknown kinds instead of disappearing', () => {
    expect(describeNotificationKind('some_future_kind')).toEqual({ icon: '✉️', label: 'some future kind' })
  })

  it('says who was added when someone else adds a person to the trip', () => {
    const e = (actor: string, id: string) => ({ verb: 'participant_joined', entity: { type: 'participant', id, label: 'participant' }, actor }) as never
    const names: Record<string, string> = { u2: 'Salim' }
    expect(renderActivity(e('u1', 'u2'), 'Tim', (id) => names[id]).text).toBe('Tim added Salim to the trip')
    expect(renderActivity(e('u1', 'u2'), 'Tim').text).toBe('Tim added someone to the trip')
    // joining yourself keeps the old wording
    expect(renderActivity(e('u1', 'u1'), 'Tim', (id) => names[id]).text).toBe('Tim joined the trip as participant')
  })

  it('has wording for re-ask and retract', () => {
    const e = (verb: string) => ({ verb, entity: { label: 'A → B' }, actor: null }) as never
    expect(renderActivity(e('settlement_re_asked'), 'Sam').text).toContain('checked again')
    expect(renderActivity(e('settlement_retracted'), 'Sam').text).toContain('marked as paid')
  })
})
