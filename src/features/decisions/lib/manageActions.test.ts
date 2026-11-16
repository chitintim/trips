import { describe, expect, it } from 'vitest'
import { answerKindChangeWarning, getManageActions, type ManageContext } from './manageActions'

const base: ManageContext = {
  canManage: true,
  stage: 'open',
  finished: false,
  shape: 'group',
  hasOptions: true,
  waitingCount: 3,
  hasWinner: false,
  onThePlan: false,
  hasFollowupTodo: false,
  hasBooking: false,
}
const ids = (c: Partial<ManageContext>) => getManageActions({ ...base, ...c }).map((a) => a.id)

describe('getManageActions', () => {
  it('gives participants nothing', () => {
    expect(ids({ canManage: false })).toEqual([])
    expect(ids({ canManage: false, stage: 'decided', hasWinner: true })).toEqual([])
  })

  it('open: decide, answers, nudge, settings, add option, delete', () => {
    expect(ids({})).toEqual(['decide', 'answers', 'nudge', 'settings', 'add_option', 'delete'])
  })

  it('open: no nudge when everyone answered, no decide without options', () => {
    expect(ids({ waitingCount: 0 })).not.toContain('nudge')
    expect(ids({ hasOptions: false })).not.toContain('decide')
  })

  it('own choice words the decide action as closing answers', () => {
    const a = getManageActions({ ...base, shape: 'own' }).find((x) => x.id === 'decide')
    expect(a?.label).toBe('Close answers')
    expect(getManageActions(base).find((x) => x.id === 'decide')?.label).toBe('Decide')
  })

  it('a closed question on a live trip says Decide now, never Close answers', () => {
    for (const shape of ['group', 'own'] as const) {
      const a = getManageActions({ ...base, stage: 'closed', shape }).find((x) => x.id === 'decide')
      expect(a?.label).toBe('Decide now')
    }
    expect(ids({ stage: 'closed' })).not.toContain('nudge')
  })

  it('finished trip: only read actions plus Reopen and Delete', () => {
    expect(ids({ finished: true, stage: 'closed' })).toEqual(['answers', 'delete'])
    expect(ids({ finished: true, stage: 'open' })).toEqual(['answers', 'delete'])
    expect(ids({ finished: true, stage: 'decided', hasWinner: true })).toEqual(['answers', 'reopen', 'delete'])
    expect(ids({ finished: true, stage: 'booked', hasWinner: true, hasBooking: true })).toEqual(['answers', 'reopen', 'delete'])
    for (const id of ['decide', 'booking', 'mark_booked', 'unmark_booked', 'schedule', 'add_todo', 'add_option', 'nudge'] as const) {
      expect(ids({ finished: true, stage: 'decided', hasWinner: true })).not.toContain(id)
    }
  })

  it('decided: schedule, to-do and booking follow the winner', () => {
    expect(ids({ stage: 'decided', hasWinner: true })).toEqual(['answers', 'schedule', 'add_todo', 'mark_booked', 'settings', 'reopen', 'delete'])
  })

  it('decided: hides schedule once it is on the plan', () => {
    expect(ids({ stage: 'decided', hasWinner: true, onThePlan: true })).not.toContain('schedule')
  })

  it('decided: hides add a to-do once one exists; no winner means no follow-ups', () => {
    expect(ids({ stage: 'decided', hasWinner: true, hasFollowupTodo: true })).not.toContain('add_todo')
    expect(ids({ stage: 'decided', hasWinner: false })).toEqual(['answers', 'settings', 'reopen', 'delete'])
  })

  it('decided offers Mark booked, plus Track booking only when a booking row exists', () => {
    expect(ids({ stage: 'decided', hasWinner: true })).toContain('mark_booked')
    expect(ids({ stage: 'decided', hasWinner: true })).not.toContain('booking')
    expect(ids({ stage: 'decided', hasWinner: true, hasBooking: true })).toEqual(['answers', 'schedule', 'add_todo', 'mark_booked', 'booking', 'settings', 'reopen', 'delete'])
    expect(getManageActions({ ...base, stage: 'decided', hasWinner: true }).find((a) => a.id === 'mark_booked')?.label).toBe('Mark booked')
  })

  it('booked is read-only plus reopen', () => {
    expect(ids({ stage: 'booked', hasWinner: true, hasBooking: true })).toEqual(['answers', 'booking', 'unmark_booked', 'reopen'])
    expect(ids({ stage: 'booked', hasWinner: true })).toEqual(['answers', 'unmark_booked', 'reopen'])
    expect(getManageActions({ ...base, stage: 'booked', hasWinner: true }).find((a) => a.id === 'unmark_booked')?.label).toBe('Not booked after all')
  })
})

describe('Ideas list manage actions', () => {
  it('offers only add idea and delete, at any stage', () => {
    expect(ids({ ideas: true })).toEqual(['add_option', 'delete'])
    expect(ids({ ideas: true, stage: 'decided', hasWinner: true })).toEqual(['add_option', 'delete'])
    expect(ids({ ideas: true, finished: true })).toEqual(['delete'])
    expect(ids({ ideas: true, canManage: false })).toEqual([])
  })
})

describe('answerKindChangeWarning', () => {
  it('is silent with no answers or no change', () => {
    expect(answerKindChangeWarning({ answerCount: 0, oldKind: 'vote', newKind: 'personal' })).toBeNull()
    expect(answerKindChangeWarning({ answerCount: 4, oldKind: 'vote', newKind: 'vote', oldMethod: 'single', newMethod: 'single' })).toBeNull()
  })
  it('warns on kind and on method change', () => {
    expect(answerKindChangeWarning({ answerCount: 1, oldKind: 'vote', newKind: 'personal' })).toMatch(/1 person has already answered.*stop counting.*count again/)
    expect(answerKindChangeWarning({ answerCount: 5, oldKind: 'vote', newKind: 'vote', oldMethod: 'ranked', newMethod: 'single' })).toMatch(/5 people have/)
  })
})
