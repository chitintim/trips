import type { TimelineEvent } from '../../../types'
import { isOwnTravelRow } from './myTravel'

/** A short fingerprint of the caller's own travel rows (ids and last-updated times), so a saved draft can tell whether it is out of date. */
export function travelFingerprint(events: TimelineEvent[], userId: string): string {
  return events
    .filter((e) => isOwnTravelRow(e, userId))
    .map((e) => `${e.id}@${e.updated_at ?? ''}`)
    .sort()
    .join('|')
}

/**
 * Whether to start the form from a stored draft or from the live record. A draft wins only when it was built on the
 * same saved travel as now AND it really differs from the live form; an untouched auto-saved draft, or one based on
 * travel that has since changed, is dropped.
 */
export function decideTravelSeed(draft: { basedOn: string } | null, liveFingerprint: string, draftDiffersFromLive: boolean): 'draft' | 'live' {
  if (!draft) return 'live'
  if (draft.basedOn !== liveFingerprint) return 'live'
  return draftDiffersFromLive ? 'draft' : 'live'
}
