import { describe, it, expect } from 'vitest'
import { bookTodoToRemove, isFunctionMissingError, toDeleteSummary } from './useDeleteQuestion'

describe('isFunctionMissingError', () => {
  it('detects PostgREST and Postgres codes', () => {
    expect(isFunctionMissingError({ code: 'PGRST202', message: 'x' })).toBe(true)
    expect(isFunctionMissingError({ code: '42883', message: 'x' })).toBe(true)
  })
  it('detects a message naming the function', () => {
    expect(isFunctionMissingError({ message: 'Could not find the function public.delete_question(p_section_id) in the schema cache' })).toBe(true)
  })
  it('ignores real failures', () => {
    expect(isFunctionMissingError({ code: '42501', message: 'Only trip organizers and admins can delete a question' })).toBe(false)
    expect(isFunctionMissingError({ message: 'Question not found' })).toBe(false)
    expect(isFunctionMissingError(null)).toBe(false)
  })
})

describe('toDeleteSummary', () => {
  it('defaults missing counts to zero', () => {
    expect(toDeleteSummary({ title: 'T', options: 3 })).toMatchObject({ title: 'T', options: 3, votes: 0, expenses_kept: 0 })
    expect(toDeleteSummary(null).title).toBe('')
  })
})

describe('bookTodoToRemove', () => {
  const action = { id: 'a1', title: 'Book: Hotel A', section_id: null, completed_at: null }
  it('removes the open Book: to-do linked from the question', () => {
    expect(bookTodoToRemove({ followup_action_id: 'a1' }, action)).toBe('a1')
  })
  it('leaves anything else alone', () => {
    expect(bookTodoToRemove({ followup_action_id: 'other' }, action)).toBeNull()
    expect(bookTodoToRemove({}, action)).toBeNull()
    expect(bookTodoToRemove(null, action)).toBeNull()
    expect(bookTodoToRemove({ followup_action_id: 'a1' }, null)).toBeNull()
    expect(bookTodoToRemove({ followup_action_id: 'a1' }, { ...action, title: 'Pay the deposit' })).toBeNull()
    expect(bookTodoToRemove({ followup_action_id: 'a1' }, { ...action, section_id: 's1' })).toBeNull()
    expect(bookTodoToRemove({ followup_action_id: 'a1' }, { ...action, completed_at: '2026-11-01T00:00:00Z' })).toBeNull()
  })
})
