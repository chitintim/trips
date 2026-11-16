// Pure "who/what is still in scope for chasing" predicates, extracted from
// index.ts so they're unit-testable without a service-role client (same
// rationale as ./actionDueDate.ts and ./outstandingTargets.ts).

const DAY_MS = 24 * 3600_000

/**
 * A participant is chaseable when they are active AND have not declined or
 * cancelled. Declined/cancelled people are out of the trip: they must not get
 * vote, action, arrival or claim reminders. (RSVP-pending reminders go to
 * 'pending'/'interested' people, who pass this check.)
 */
export function isChaseableParticipant(p: { active?: boolean | null; confirmation_status?: string | null }): boolean {
  if (p.active === false) return false
  return p.confirmation_status !== 'declined' && p.confirmation_status !== 'cancelled'
}

/**
 * A trip still earns reminders unless it is marked completed or its end date
 * (UTC calendar day) has already passed. The end date itself still counts.
 */
export function isTripOpenForReminders(trip: { status?: string | null; end_date?: string | null }, now: Date): boolean {
  if (trip.status === 'trip_completed') return false
  if (trip.end_date) {
    const endOfEndDay = new Date(trip.end_date + 'T00:00:00Z').getTime() + DAY_MS
    if (endOfEndDay <= now.getTime()) return false
  }
  return true
}

/** A planning section whose status is 'completed' is closed: nothing left to vote on or pick. */
export function isSectionClosed(section: { status?: string | null }): boolean {
  return section.status === 'completed'
}

/**
 * True when the participant joined AFTER the action's due day had fully
 * elapsed -- they must not be sent an "Overdue" email for a deadline that
 * passed before they were on the trip.
 */
export function joinedAfterDueDate(joinedAtIso: string | null | undefined, dueDateStr: string): boolean {
  if (!joinedAtIso) return false
  const joined = new Date(joinedAtIso).getTime()
  if (Number.isNaN(joined)) return false
  return joined >= new Date(dueDateStr + 'T00:00:00Z').getTime() + DAY_MS
}

/**
 * Which chase families apply to a trip right now. Planning-phase chases
 * (votes, picks, RSVP, arrival details) stop once the trip is finished;
 * money chases (unclaimed items, settlements) never do -- settling up
 * happens exactly after the trip ends.
 */
export function chaseScopes(
  trip: { status?: string | null; end_date?: string | null },
  now: Date
): { planning: boolean; money: boolean } {
  return { planning: isTripOpenForReminders(trip, now), money: true }
}
