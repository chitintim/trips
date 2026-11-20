import { confirmationDeadlineDate } from './rsvpStanding'

/**
 * The reply-by deadline as the END of its calendar day in the viewer's local
 * time, so the chip says "Deadline passed" only once the day itself is over
 * (the stored value is midnight UTC on that date).
 */
export function replyByEnd(deadline: string | null | undefined): string | null {
  const date = confirmationDeadlineDate(deadline)
  return date ? `${date}T23:59:59` : null
}

/** "18 November 2026", formatted from the date part only (no time zone drift). */
export function formatReplyByDate(deadline: string | null | undefined): string | null {
  const date = confirmationDeadlineDate(deadline)
  if (!date) return null
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

/** The Answer the "I'd still like to come" / "I'm out" buttons preselect. */
export const STILL_COMING_LABEL = "I'd still like to come"
export const OUT_LABEL = "I'm out"
