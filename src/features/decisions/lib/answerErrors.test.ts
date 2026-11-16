import { describe, it, expect } from 'vitest'
import { describeAnswerError } from './answerCopy'

const CLOSED = 'Answers are closed for this question, so your answer was not saved.'

describe('describeAnswerError (closed questions)', () => {
  it('recognises the votes/passes guard message and hint', () => {
    expect(describeAnswerError(new Error('Voting is closed for this question'))).toBe(CLOSED)
    expect(describeAnswerError({ message: 'x', hint: 'voting_closed' })).toBe(CLOSED)
  })
  it('recognises the selections guard message and hint', () => {
    expect(describeAnswerError(new Error('Answers are closed for this question'))).toBe(CLOSED)
    expect(describeAnswerError({ message: 'boom', hint: 'answers_closed' })).toBe(CLOSED)
  })
  it('keeps other messages', () => {
    expect(describeAnswerError(new Error('Something else'))).toBe('Something else')
    expect(describeAnswerError(null)).toBe('Your answer could not be saved.')
  })
})
