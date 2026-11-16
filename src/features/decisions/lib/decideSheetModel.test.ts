import { describe, expect, it } from 'vitest'
import {
  buildDecideInput,
  buildMarkBookedBooking,
  decideBlocker,
  decideDefaults,
  decideToastMessage,
  eventCategoryForSection,
  isBookableSectionType,
  readOptionPlanDate,
  shortDate,
  shouldOfferExpense,
  type DecideFormState,
} from './decideSheetModel'

const form: DecideFormState = {
  sectionId: 's1',
  own: false,
  optionId: 'o1',
  putOnPlan: false,
  date: '2026-08-17',
  startTime: '',
  bookTodo: false,
  assignedTo: 'u1',
  dueDate: '',
}

describe('toggle defaults', () => {
  it('bookable kinds default the Book it to-do on', () => {
    for (const t of ['accommodation', 'flights', 'transport', 'activities', 'lessons']) expect(isBookableSectionType(t)).toBe(true)
    for (const t of ['equipment', 'insurance', null, undefined]) expect(isBookableSectionType(t)).toBe(false)
    expect(decideDefaults({ sectionType: 'accommodation', optionDate: null })).toEqual({ putOnPlan: false, bookTodo: true })
    expect(decideDefaults({ sectionType: 'equipment', optionDate: null })).toEqual({ putOnPlan: false, bookTodo: false })
  })
  it('the plan toggle defaults on only when the option carries a date', () => {
    const d = readOptionPlanDate({ proposed_date: '2026-08-17', proposed_start_time: '09:30:00' })
    expect(d).toEqual({ date: '2026-08-17', startTime: '09:30', endTime: null })
    expect(decideDefaults({ sectionType: 'activities', optionDate: d }).putOnPlan).toBe(true)
    expect(readOptionPlanDate({}, null)).toBeNull()
    expect(readOptionPlanDate({ proposed_date: 'soon' })).toBeNull()
  })
  it('falls back to the question date when the option has none', () => {
    expect(readOptionPlanDate({}, { proposed_date: '2026-09-01' })?.date).toBe('2026-09-01')
  })
  it('maps question kinds to event categories', () => {
    expect(eventCategoryForSection('flights')).toBe('flight')
    expect(eventCategoryForSection('lessons')).toBe('activity')
    expect(eventCategoryForSection('insurance')).toBe('other')
  })
})

describe('buildDecideInput', () => {
  it('Own choice sends only the section', () => {
    expect(buildDecideInput({ ...form, own: true, optionId: null, putOnPlan: true, bookTodo: true })).toEqual({ sectionId: 's1' })
  })
  it('a bare decision has no plan and no to-do', () => {
    expect(buildDecideInput(form)).toEqual({ sectionId: 's1', optionId: 'o1', putOnPlan: null, bookTodo: null })
  })
  it('plan: all day without a time, timed with one', () => {
    expect(buildDecideInput({ ...form, putOnPlan: true }).putOnPlan).toEqual({ date: '2026-08-17', all_day: true })
    expect(buildDecideInput({ ...form, putOnPlan: true, startTime: '10:00' }).putOnPlan).toEqual({ date: '2026-08-17', start_time: '10:00', all_day: false })
  })
  it('to-do carries the assignee and only a filled-in due date', () => {
    expect(buildDecideInput({ ...form, bookTodo: true }).bookTodo).toEqual({ assigned_to: 'u1' })
    expect(buildDecideInput({ ...form, bookTodo: true, dueDate: '2026-07-01' }).bookTodo).toEqual({ assigned_to: 'u1', due_date: '2026-07-01' })
  })
})

describe('decideBlocker', () => {
  it('needs a winner for a group choice, nothing for an own choice', () => {
    expect(decideBlocker({ ...form, optionId: null })).toMatch(/winning option/)
    expect(decideBlocker({ ...form, own: true, optionId: null })).toBeNull()
    expect(decideBlocker(form)).toBeNull()
  })
  it('a tie with nothing chosen says so; choosing clears it', () => {
    expect(decideBlocker({ ...form, optionId: null }, true)).toMatch(/tie/)
    expect(decideBlocker(form, true)).toBeNull()
  })
  it('needs a day when putting it on the plan', () => {
    expect(decideBlocker({ ...form, putOnPlan: true, date: '' })).toMatch(/day/)
    expect(decideBlocker({ ...form, putOnPlan: true })).toBeNull()
  })
})

describe('toasts', () => {
  it('says it is on the plan only when an event was made', () => {
    expect(decideToastMessage({ own: false, sectionTitle: 'Stay', optionTitle: 'Osaka Airbnb', planDate: '2026-08-17', result: { event_id: 'e', action_id: null, already_decided: false } }).message).toBe(
      "Decided: Osaka Airbnb — it's on the plan for 17 Aug"
    )
    expect(decideToastMessage({ own: false, sectionTitle: 'Stay', optionTitle: 'Osaka Airbnb', planDate: null, result: { event_id: null, action_id: 'a', already_decided: false } })).toEqual({
      message: 'Decided: Osaka Airbnb',
      description: 'A to-do to book it was added.',
    })
    expect(decideToastMessage({ own: true, sectionTitle: 'Ski hire', optionTitle: null, planDate: null, result: { event_id: null, action_id: null, already_decided: false } }).message).toBe('Answers closed: Ski hire')
  })
  it('formats short dates', () => {
    expect(shortDate('2026-01-05')).toBe('5 Jan')
  })
})

describe('mark booked payload', () => {
  const base = { optionTitle: 'Osaka Airbnb', reference: '', amount: '', currency: 'gbp' }
  it('no details means no booking row', () => {
    expect(buildMarkBookedBooking(base)).toBeNull()
    expect(buildMarkBookedBooking({ ...base, amount: '0' })).toBeNull()
  })
  it('a reference alone is reserved; an amount makes it paid', () => {
    expect(buildMarkBookedBooking({ ...base, reference: ' HMX42 ' })).toEqual({ title: 'Osaka Airbnb', confirmation_ref: 'HMX42', status: 'reserved' })
    expect(buildMarkBookedBooking({ ...base, amount: '120.5' })).toEqual({ title: 'Osaka Airbnb', amount: 120.5, currency: 'GBP', status: 'paid' })
  })
  it('offers an expense only for a positive amount on a created booking', () => {
    expect(shouldOfferExpense({ amount: '50' }, 'b1')).toBe(true)
    expect(shouldOfferExpense({ amount: '50' }, null)).toBe(false)
    expect(shouldOfferExpense({ amount: '' }, 'b1')).toBe(false)
  })
})
