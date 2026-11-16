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

import { claimLabel, claimedByLabel, leftLabel, TODOS_EMPTY_BODY, TODOS_EMPTY_TITLE } from './todoLabels'

describe('grouped sheet wording', () => {
  it('uses one claim verb per kind', () => {
    expect(claimLabel(false)).toBe("I'll do it")
    expect(claimLabel(true)).toBe("I'll bring it")
    expect(claimedByLabel('Sam', false, true)).toBe('Sam is bringing it')
    expect(claimedByLabel(null, true, false)).toBe("You're on it")
  })

  it('lists who is left', () => {
    expect(leftLabel([])).toBe('')
    expect(leftLabel(['Sam'])).toBe('Left: Sam')
    expect(leftLabel(['Sam', 'Priya'])).toBe('Left: Sam and Priya')
    expect(leftLabel(['A', 'B', 'C', 'D', 'E'])).toBe('Left: A, B and 3 more')
  })

  it('keeps the 5.8 empty state', () => {
    expect(TODOS_EMPTY_TITLE).toBe('No to-dos.')
    expect(TODOS_EMPTY_BODY).toContain('Book the transfer')
  })
})
