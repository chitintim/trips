import { describe, it, expect } from 'vitest'
import { resolvePostLoginDestination } from './postLoginRedirect'

describe('resolvePostLoginDestination', () => {
  it('returns the fallback when there is no stashed location', () => {
    expect(resolvePostLoginDestination(undefined)).toBe('/')
    expect(resolvePostLoginDestination(null)).toBe('/')
    expect(resolvePostLoginDestination({})).toBe('/')
    expect(resolvePostLoginDestination({ from: {} })).toBe('/')
  })

  it('round-trips a plain path', () => {
    expect(resolvePostLoginDestination({ from: { pathname: '/some-trip-id' } })).toBe('/some-trip-id')
  })

  it('preserves query strings (claim links)', () => {
    expect(
      resolvePostLoginDestination({ from: { pathname: '/claim/ABC123', search: '?item=4' } })
    ).toBe('/claim/ABC123?item=4')
  })

  it('preserves ?tab= deep links into a trip', () => {
    expect(
      resolvePostLoginDestination({ from: { pathname: '/trip-1', search: '?tab=money' } })
    ).toBe('/trip-1?tab=money')
  })

  it('preserves hashes', () => {
    expect(
      resolvePostLoginDestination({ from: { pathname: '/trip-1', search: '?tab=plan', hash: '#day-3' } })
    ).toBe('/trip-1?tab=plan#day-3')
  })

  it('honors a custom fallback', () => {
    expect(resolvePostLoginDestination(undefined, '/dashboard')).toBe('/dashboard')
  })

  // Returning-user invite path (P2): JoinTrip's "Sign in first" link now
  // carries `state: { from: { pathname: '/join/:code' } }` so signing in
  // lands the user back on the teaser instead of a dead-end /login.
  it('round-trips the /join/:code invite teaser', () => {
    expect(resolvePostLoginDestination({ from: { pathname: '/join/ABCD1234' } })).toBe('/join/ABCD1234')
  })
})
