import { describe, expect, it } from 'vitest'
import { allTodosRowLabel, openSheetCount } from './todoSheetSummary'

describe('allTodosRowLabel', () => {
  it('shows the open count when the viewer has their own to-dos', () => {
    expect(allTodosRowLabel({ openCount: 5, mine: 2, canCreate: true })).toBe('Shared to-dos (5 open) →')
  })
  it('still offers the sheet when the viewer personally has none', () => {
    expect(allTodosRowLabel({ openCount: 3, mine: 0, canCreate: true })).toBe("See shared to-dos →")
    expect(allTodosRowLabel({ openCount: 3, mine: 0, canCreate: false })).toBe("See shared to-dos →")
  })
  it('lets anyone who may create reach New to-do on an empty list, and is never hidden', () => {
    expect(allTodosRowLabel({ openCount: 0, mine: 0, canCreate: true })).toBe('Add a shared to-do →')
    expect(allTodosRowLabel({ openCount: 0, mine: 0, canCreate: false })).toBe("See shared to-dos →")
  })
  it('on a finished trip the row is the history, even with a personal to-do and nothing in the sheet', () => {
    expect(allTodosRowLabel({ openCount: 0, mine: 1, canCreate: false, finished: true })).toBe('Shared to-do history →')
  })
  it('counts every open group, not Done', () => {
    const g = { yours: [1], everyone: [1, 2], others: [], upForGrabs: [1] } as never
    expect(openSheetCount(g)).toBe(4)
  })
})
