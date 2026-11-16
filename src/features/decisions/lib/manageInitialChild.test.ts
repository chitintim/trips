import { describe, it, expect } from 'vitest'
import { planInitialChild, type InitialChildSection } from './manageInitialChild'

const open: InitialChildSection = { status: 'in_progress', options: [{ id: 'a', status: 'available' }, { id: 'b', status: 'available' }], own: false, decidedOptionId: null }
const decided: InitialChildSection = { status: 'completed', options: [{ id: 'a', status: 'available' }, { id: 'b', status: 'available' }], own: false, decidedOptionId: 'a' }
const base = { canManage: true, finished: false }

describe('planInitialChild', () => {
  it('no request opens the home view', () => {
    expect(planInitialChild({ ...base, section: open })).toEqual({ child: null })
  })
  it('decide opens Decide on an open question (also Own choice: Close answers)', () => {
    expect(planInitialChild({ ...base, initialChild: 'decide', section: open })).toEqual({ child: 'decide' })
    expect(planInitialChild({ ...base, initialChild: 'decide', section: { ...open, own: true, options: [] } })).toEqual({ child: 'decide' })
  })
  it('decide fails soft when decided, empty, finished or not an organizer', () => {
    expect(planInitialChild({ ...base, initialChild: 'decide', section: decided })).toEqual({ child: null })
    expect(planInitialChild({ ...base, initialChild: 'decide', section: { ...open, options: [{ id: 'a', status: 'cancelled' }] } })).toEqual({ child: null })
    expect(planInitialChild({ ...base, finished: true, initialChild: 'decide', section: open })).toEqual({ child: null })
    expect(planInitialChild({ ...base, canManage: false, initialChild: 'decide', section: open })).toEqual({ child: null })
  })
  it('booking opens Mark booked for the option in the link, else for the decided option', () => {
    expect(planInitialChild({ ...base, initialChild: 'booking', initialOptionId: 'b', section: decided })).toEqual({ child: 'mark_booked', optionId: 'b' })
    expect(planInitialChild({ ...base, initialChild: 'booking', section: decided })).toEqual({ child: 'mark_booked', optionId: 'a' })
  })
  it('booking fails soft: undecided, unknown or cancelled option, already booked, own choice, finished, not an organizer', () => {
    const none = { child: null }
    expect(planInitialChild({ ...base, initialChild: 'booking', initialOptionId: 'a', section: open })).toEqual(none)
    expect(planInitialChild({ ...base, initialChild: 'booking', initialOptionId: 'zzz', section: decided })).toEqual(none)
    expect(planInitialChild({ ...base, initialChild: 'booking', initialOptionId: 'a', section: { ...decided, options: [{ id: 'a', status: 'cancelled' }] } })).toEqual(none)
    expect(planInitialChild({ ...base, initialChild: 'booking', initialOptionId: 'a', section: { ...decided, options: [{ id: 'a', status: 'booked' }] } })).toEqual(none)
    expect(planInitialChild({ ...base, initialChild: 'booking', section: { ...decided, decidedOptionId: null } })).toEqual(none)
    expect(planInitialChild({ ...base, initialChild: 'booking', section: { ...decided, own: true } })).toEqual(none)
    expect(planInitialChild({ ...base, finished: true, initialChild: 'booking', section: decided })).toEqual(none)
    expect(planInitialChild({ ...base, canManage: false, initialChild: 'booking', section: decided })).toEqual(none)
  })
})
