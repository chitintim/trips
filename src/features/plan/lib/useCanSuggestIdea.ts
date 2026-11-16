import { useAuth } from '../../../hooks/useAuth'
import { useTripPermissions } from '../../../hooks/useTripPermissions'
import { useParticipants } from '../../../lib/queries/useTrip'
import { useSuggestionsAvailable } from '../../../lib/queries/useSuggestions'
import { isTripFinished } from '../../../lib/answers/answers'
import { isViewerOut } from '../../decisions/lib/answerModel'
import { canSuggestIdea } from '../../decisions/lib/suggestOption'
import type { Trip } from '../../../types'

/**
 * True when this viewer is a participant (not an organizer) who may add an idea through the Add flow:
 * they are coming, the trip is not finished and the suggest RPC exists (fail-soft before the migration).
 * Organizers get all three intents through `availableIntents(canManageTrip)` instead.
 */
export function useCanSuggestIdea(trip: Trip | null | undefined): boolean {
  const { user } = useAuth()
  const { data: participants } = useParticipants(trip?.id)
  const { canManageTrip } = useTripPermissions(trip)
  const rpcAvailable = useSuggestionsAvailable()
  const mine = (participants ?? []).some((p) => p.user_id === user?.id)
  return canSuggestIdea({
    rpcAvailable,
    userId: mine ? user?.id ?? null : null,
    viewerOut: isViewerOut(user?.id ?? null, participants ?? []),
    tripFinished: !trip || isTripFinished(trip),
    canManageTrip,
  })
}
