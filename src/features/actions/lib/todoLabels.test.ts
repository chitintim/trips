import { describe, it, expect } from 'vitest'
import { whoLabel, doneCountLabel, todoCountLabel, WHO_EVERYONE, WHO_ANYONE, TODOS_TITLE } from './todoLabels'

describe('todoLabels', () => {
  it('labels the three Who modes', () => {
    expect(whoLabel('everyone')).toBe('Everyone')
    expect(whoLabel('person', 'Sam')).toBe('Sam')
    expect(whoLabel('person')).toBe('Someone')
    expect(whoLabel('anyone')).toBe('Anyone — first to grab it')
    expect(WHO_EVERYONE).toBe('Everyone')
    expect(WHO_ANYONE).toBe('Anyone — first to grab it')
  })

  it('uses one done-count wording', () => {
    expect(doneCountLabel(3, 9)).toBe('3 of 9 done')
    expect(doneCountLabel(0, 0)).toBe('0 of 0 done')
  })

  it('pluralises the to-do count', () => {
    expect(todoCountLabel(1)).toBe('1 to-do')
    expect(todoCountLabel(4)).toBe('4 to-dos')
    expect(TODOS_TITLE).toBe('To-dos')
  })
})
