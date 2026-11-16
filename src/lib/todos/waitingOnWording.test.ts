import { describe, it, expect } from 'vitest'
import { anyOrganizerLabel, unblocksLabel } from './copy'
import { summaryLine } from '../../features/today/lib/organiserSummaryModel'
import type { WaitingOnItem } from './types'

// Japan 2026: nine organizers can freeze balances; six people are blocked until it happens.
describe('waiting on: who can act vs who is blocked', () => {
  it('separates the two numbers', () => {
    expect(anyOrganizerLabel(9)).toBe('Any organizer can do this (9)')
    expect(unblocksLabel(6)).toBe("6 people can't settle until then")
    expect(unblocksLabel(1)).toBe("1 person can't settle until then")
  })

  it('the Today summary line does not say "9 people" owe the freeze', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
    const item = { id: 'x', kind: 'org_setup', title: 'Freeze balances so people can settle', userIds: ids, unblocks: 6 } as unknown as WaitingOnItem
    const line = summaryLine(item, ids.slice(1), (x) => x)
    expect(line).toBe('Any organizer: freeze balances so people can settle')
  })
})
