import { describe, expect, it } from 'vitest'
import { displayNames } from './claimNames'

const labels = (names: Array<string | null>, emails: Array<string | null> = []) =>
  [...displayNames(names.map((n, i) => ({ id: String(i), fullName: n, email: emails[i] ?? null }))).values()].map((d) => d.label)

describe('displayNames', () => {
  it('uses the first name when first names differ', () => {
    expect(labels(['Tim Lam', 'Sam Jones', 'Ana'])).toEqual(['Tim', 'Sam', 'Ana'])
  })
  it('adds the last initial when first names collide', () => {
    expect(labels(['Tim Lam', 'Tim Tran', 'Sam Jones'])).toEqual(['Tim L.', 'Tim T.', 'Sam'])
  })
  it('uses the bracketed part for names like "Tim (Test)" and never cuts it', () => {
    expect(labels(['Tim (Test)', 'Tim Lam'])).toEqual(['Tim (Test)', 'Tim L.'])
    expect(labels(['Tim (Test)', 'Tim (Work)'])).toEqual(['Tim (Test)', 'Tim (Work)'])
  })
  it('does not disambiguate people whose first names already differ', () => {
    expect(labels(['Tim (Test)', 'Sam'])).toEqual(['Tim', 'Sam'])
  })
  it('goes to whole last names when the initials collide', () => {
    expect(labels(['Tim Lam', 'Tim Lee'])).toEqual(['Tim Lam', 'Tim Lee'])
    expect(labels(['Tim Lam', 'Tim Lee', 'Tim Tran'])).toEqual(['Tim Lam', 'Tim Lee', 'Tim T.'])
  })
  it('handles single-word names that collide (cannot be told apart, so numbered)', () => {
    expect(labels(['Tim', 'Tim'])).toEqual(['Tim', 'Tim (2)'])
    expect(labels(['Tim', 'Tim Lam'])).toEqual(['Tim', 'Tim L.'])
  })
  it('collides case-insensitively', () => {
    expect(labels(['tim lam', 'Tim Tran'])).toEqual(['tim L.', 'Tim T.'])
  })
  it('keeps long names whole, with no dot unless it is an initial', () => {
    expect(labels(['Maximilian Featherstonehaugh', 'Maximilian Cholmondeley'])).toEqual(['Maximilian F.', 'Maximilian C.'])
    expect(labels(['Maximilian Featherstonehaugh', 'Sam'])).toEqual(['Maximilian', 'Sam'])
    for (const l of labels(['Tim Lam', 'Tim Lee', 'Tim (Test)'])) expect(l).not.toMatch(/[A-Za-z]{2,}\.$/)
  })
  it('works for non-Latin names', () => {
    expect(labels(['李 小龙', '李 大明'])).toEqual(['李 小.', '李 大.'])
    expect(labels(['李小龙', 'Sam'])).toEqual(['李小龙', 'Sam'])
    expect(labels(['José Álvarez', 'José Ñandú'])).toEqual(['José Á.', 'José Ñ.'])
  })
  it('falls back to the email name, then "Someone"', () => {
    expect(labels([null, ''], ['sam@x.test', null])).toEqual(['sam', 'Someone'])
  })
  it('keeps the full name for aria-labels', () => {
    const m = displayNames([
      { id: 'a', fullName: 'Tim (Test)' },
      { id: 'b', fullName: 'Tim  Lam ' },
    ])
    expect(m.get('a')).toEqual({ label: 'Tim (Test)', full: 'Tim (Test)' })
    expect(m.get('b')).toEqual({ label: 'Tim L.', full: 'Tim Lam' })
  })
  it('labels are unique within the set', () => {
    const l = labels(['Tim Lam', 'Tim Lam', 'Tim Lee', 'Tim (Test)'])
    expect(new Set(l.map((x) => x.toLowerCase())).size).toBe(l.length)
  })
})
