import { describe, it, expect } from 'vitest'
import { accountStatusBadges } from './invitationAccountStatus'

describe('accountStatusBadges', () => {
  it('flags both problems for the motivating stuck-account case (unconfirmed, never signed in)', () => {
    const badges = accountStatusBadges({ account_email_confirmed_at: null, account_last_sign_in_at: null })
    expect(badges).toEqual([
      { label: 'Email not confirmed', variant: 'error' },
      { label: 'Never logged in', variant: 'warning' },
    ])
  })

  it('flags only the unconfirmed problem when a sign-in somehow happened anyway', () => {
    const badges = accountStatusBadges({ account_email_confirmed_at: null, account_last_sign_in_at: '2026-07-20T10:00:00Z' })
    expect(badges).toEqual([{ label: 'Email not confirmed', variant: 'error' }])
  })

  it('flags only never-logged-in once confirmed but no login yet', () => {
    const badges = accountStatusBadges({
      account_email_confirmed_at: '2026-07-20T10:00:00Z',
      account_last_sign_in_at: null,
    })
    expect(badges).toEqual([{ label: 'Never logged in', variant: 'warning' }])
  })

  it('reports Active with no problem badges when confirmed and logged in', () => {
    const badges = accountStatusBadges({
      account_email_confirmed_at: '2026-07-20T10:00:00Z',
      account_last_sign_in_at: '2026-07-21T08:00:00Z',
    })
    expect(badges).toEqual([{ label: 'Active', variant: 'success' }])
  })
})
