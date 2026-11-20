import { describe, expect, it } from 'vitest'
import { setOffLine } from './setOffLine'

const today = new Date(2026, 10, 20, 23, 30) // 20 Nov 2026, late evening local

describe('setOffLine', () => {
  it('says today', () => expect(setOffLine('2026-11-20', '2026-12-10', today)).toBe('You set off today'))
  it('says tomorrow', () => expect(setOffLine('2026-11-21', '2026-12-10', today)).toBe('You set off tomorrow'))
  it('names a later date', () =>
    expect(setOffLine('2026-12-06', '2026-12-10', today)).toBe('You set off Sunday 6 December'))
  it('is null on or after the trip start', () => {
    expect(setOffLine('2026-12-10', '2026-12-10', today)).toBeNull()
    expect(setOffLine('2026-12-11', '2026-12-10', today)).toBeNull()
  })
  it('is null before today', () => expect(setOffLine('2026-11-19', '2026-12-10', today)).toBeNull())
  it('is null with no travel', () => expect(setOffLine(null, '2026-12-10', today)).toBeNull())
})
