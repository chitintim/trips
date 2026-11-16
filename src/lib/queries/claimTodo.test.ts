import { describe, it, expect } from 'vitest'
import { claimTodoErrorMessage, isClaimTodoMissing } from './claimTodo'

describe('isClaimTodoMissing', () => {
  it('detects PostgREST / Postgres missing-function errors', () => {
    expect(isClaimTodoMissing({ code: 'PGRST202', message: 'x' })).toBe(true)
    expect(isClaimTodoMissing({ code: '42883', message: 'x' })).toBe(true)
    expect(isClaimTodoMissing({ message: 'Could not find the function public.claim_todo(p_action) in the schema cache' })).toBe(true)
  })
  it('does not treat rule or permission errors as missing', () => {
    expect(isClaimTodoMissing(null)).toBe(false)
    expect(isClaimTodoMissing({ code: 'P0001', message: 'Someone else just took this one' })).toBe(false)
    expect(isClaimTodoMissing({ code: '42501', message: 'You are not on this trip' })).toBe(false)
  })
})

describe('claimTodoErrorMessage', () => {
  it('passes through the server message for rule / permission errors', () => {
    expect(claimTodoErrorMessage({ code: 'P0001', message: 'Someone else just took this one' }, 'claim')).toBe('Someone else just took this one')
    expect(claimTodoErrorMessage({ code: '42501', message: 'You are not on this trip' }, 'tick')).toBe('You are not on this trip')
  })
  it('falls back to friendly wording per action for anything else', () => {
    expect(claimTodoErrorMessage({ message: 'boom' }, 'claim')).toMatch(/Someone else just took this one/)
    expect(claimTodoErrorMessage({ message: 'boom' }, 'give_back')).toMatch(/give this one back/)
    expect(claimTodoErrorMessage({ message: 'boom' }, 'untick')).toMatch(/update this one/)
  })
  it('explains a missing function', () => {
    expect(claimTodoErrorMessage({ code: 'PGRST202' }, 'claim')).toMatch(/not available yet/)
  })
})
