import { describe, it, expect } from 'vitest'
import { assertCountAffected, assertRowsAffected, throwIfError } from './assertRowsAffected'

describe('assertRowsAffected', () => {
  it('throws when RLS matched zero rows', () => {
    expect(() => assertRowsAffected([], 'nope')).toThrow('nope')
    expect(() => assertRowsAffected(null, 'nope')).toThrow('nope')
  })
  it('passes when a row changed', () => {
    expect(() => assertRowsAffected([{ id: 1 }], 'nope')).not.toThrow()
  })
})

describe('assertCountAffected', () => {
  it('throws on 0 / null / undefined', () => {
    expect(() => assertCountAffected(0, 'nope')).toThrow('nope')
    expect(() => assertCountAffected(null, 'nope')).toThrow('nope')
    expect(() => assertCountAffected(undefined, 'nope')).toThrow('nope')
  })
  it('passes when at least one row changed', () => {
    expect(() => assertCountAffected(1, 'nope')).not.toThrow()
  })
})

describe('throwIfError', () => {
  it('does nothing without an error', () => {
    expect(() => throwIfError(null)).not.toThrow()
    expect(() => throwIfError(undefined)).not.toThrow()
  })
  it('throws a real Error carrying the server message and code from a plain object', () => {
    let caught: unknown
    try {
      throwIfError({ message: 'Voting is closed for this question', code: 'P0001', hint: 'voting_closed' })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('Voting is closed for this question')
    expect((caught as Error & { code?: string }).code).toBe('P0001')
  })
})
