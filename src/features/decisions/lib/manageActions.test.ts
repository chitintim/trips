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
  canSchedule: true,
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
    for (const id of ['decide', 'booking', 'schedule', 'add_todo', 'add_option', 'nudge'] as const) {
      expect(ids({ finished: true, stage: 'decided', hasWinner: true })).not.toContain(id)
    }
  })

  it('decided: schedule, to-do and booking follow the winner', () => {
    expect(ids({ stage: 'decided', hasWinner: true })).toEqual(['answers', 'schedule', 'add_todo', 'booking', 'settings', 'reopen', 'delete'])
  })

  it('decided: hides schedule when already on the plan or when the host cannot schedule', () => {
    expect(ids({ stage: 'decided', hasWinner: true, onThePlan: true })).not.toContain('schedule')
    expect(ids({ stage: 'decided', hasWinner: true, canSchedule: false })).not.toContain('schedule')
  })

  it('decided: hides add a to-do once one exists; no winner means no follow-ups', () => {
    expect(ids({ stage: 'decided', hasWinner: true, hasFollowupTodo: true })).not.toContain('add_todo')
    expect(ids({ stage: 'decided', hasWinner: false })).toEqual(['answers', 'settings', 'reopen', 'delete'])
  })

  it('booking action reads Mark booked, then Track booking', () => {
    const f = (hasBooking: boolean) => getManageActions({ ...base, stage: 'decided', hasWinner: true, hasBooking }).find((a) => a.id === 'booking')?.label
    expect(f(false)).toBe('Mark booked')
    expect(f(true)).toBe('Track booking')
  })

  it('booked is read-only plus reopen', () => {
    expect(ids({ stage: 'booked', hasWinner: true, hasBooking: true })).toEqual(['answers', 'booking', 'reopen'])
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
