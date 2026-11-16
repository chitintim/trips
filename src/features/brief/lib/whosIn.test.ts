import { describe, it, expect } from 'vitest'
import { buildWhosIn, firstNameOf } from './whosIn'

const p = (id: string, name: string, status: any, active = true) => ({ id, name, status, active })

describe('buildWhosIn', () => {
  const people = [
    p('1', 'Chai Lam', 'confirmed'),
    p('2', 'Florence B', 'pending'),
    p('3', 'Jeremy K', 'pending'),
    p('4', 'Ann', 'interested'),
    p('5', 'Bob', 'conditional'),
    p('6', 'Cy', 'declined'),
    p('7', 'Di', 'waitlist'),
    p('8', 'Gone', 'confirmed', false),
  ]
  it('groups by reply, going first, omitting empty groups, excluding inactive', () => {
    const m = buildWhosIn(people, true)
    expect(m.groups.map((g) => [g.label, g.count])).toEqual([
      ['Going', 1],
      ['Not sure', 2],
      ['No reply yet', 2],
      ['Waitlist', 1],
      ['Not going', 1],
    ])
    expect(m.heading).toBe("Who's coming · 1 going · 7 invited")
    expect(m.groups[0].people[0].firstName).toBe('Chai')
  })
  it('omits empty groups', () => {
    const m = buildWhosIn([p('1', 'A', 'confirmed')], true)
    expect(m.groups).toHaveLength(1)
  })
  it('lists everyone ungrouped when tracking is off', () => {
    const m = buildWhosIn(people, false)
    expect(m.groups).toHaveLength(1)
    expect(m.groups[0].count).toBe(7)
    expect(m.heading).toBe("Who's on this trip · 7")
  })
  it('handles missing names', () => {
    expect(firstNameOf(null)).toBe('Someone')
  })
})
