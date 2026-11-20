import type { RsvpStanding } from './rsvpStanding'

/**
 * "1 not sure" for the Who's coming summary; "1 not sure (trip full)" when
 * every one of them is down as not sure only because the trip is full.
 */
export function notSureSummary(count: number, standings: ReadonlyMap<string, RsvpStanding>): string {
  const base = `${count} not sure`
  const fullCount = [...standings.values()].filter((s) => (s.status === 'interested' || s.status === 'conditional') && s.kind === 'no_place' && !s.placeHeld).length
  return count > 0 && fullCount === count ? `${base} (trip full)` : base
}

export interface NotAskedPerson {
  name: string
  standing: RsvpStanding
}

/**
 * One quiet line for the Waiting-on board naming people who are NOT being
 * asked "Are you coming?" and why, e.g. "Not asking: Tim — not sure, but the
 * trip is full." Null when everyone is being asked as normal.
 */
export function notAskingLine(people: ReadonlyArray<NotAskedPerson>): string | null {
  const parts = people
    .filter(({ standing }) => standing.kind === 'no_place' || standing.kind === 'closed')
    .map(({ name, standing }) => {
      const answer = standing.status === 'interested' || standing.status === 'conditional' ? 'not sure' : 'no reply'
      const why = standing.kind === 'closed' ? 'and replies have closed' : standing.placeHeld ? 'a free place goes to the waitlist first' : 'but the trip is full'
      return `${name} — ${answer}, ${why}`
    })
  return parts.length ? `Not asking: ${parts.join('; ')}.` : null
}

/** True when the notice stands in for the usual "Update my answer" button (a plain waitlister keeps it). */
export function standingReplacesAnswerButton(standing: RsvpStanding): boolean {
  return (standing.kind === 'no_place' || standing.kind === 'closed') && !standing.underway
}
