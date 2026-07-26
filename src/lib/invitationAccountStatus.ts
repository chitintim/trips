export interface AccountStatusBadge {
  label: string
  variant: 'error' | 'warning' | 'success'
}

/**
 * At-a-glance problem badges for an invitation's produced account -- the
 * whole point of the site-admin Invitations page's account column (and the
 * reason get_invitation_admin_details exists at all): spotting stuck
 * accounts like the real case, chrisceungsc123@gmail.com (unconfirmed,
 * never signed in), without having to open every row.
 *
 * The two problems are evaluated independently rather than folded into one
 * combined "stuck" state, because they CAN occur separately (e.g. confirmed
 * but never logged back in, or -- in principle -- signed in once via a
 * magic link before formally confirming). The motivating case happens to
 * hit both at once, which is exactly what makes it stand out here: two red
 * flags instead of one.
 */
export function accountStatusBadges(account: {
  account_email_confirmed_at: string | null
  account_last_sign_in_at: string | null
}): AccountStatusBadge[] {
  const badges: AccountStatusBadge[] = []
  if (!account.account_email_confirmed_at) {
    badges.push({ label: 'Email not confirmed', variant: 'error' })
  }
  if (!account.account_last_sign_in_at) {
    badges.push({ label: 'Never logged in', variant: 'warning' })
  }
  if (badges.length === 0) {
    badges.push({ label: 'Active', variant: 'success' })
  }
  return badges
}
