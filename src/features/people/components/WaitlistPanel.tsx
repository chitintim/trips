import { UserAvatar, Badge, Button, Deadline, EmptyState, useToast } from '../../../components/ui'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import { getWaitlistQueue, getNextWaitlistOffer } from '../lib/waitlist'
import { useOfferWaitlistSpot, useClearWaitlistOffer } from '../lib/useWaitlistOffer'

interface WaitlistPanelProps {
  tripId: string
  participants: ParticipantWithUser[]
  isOrganizer: boolean
}

function displayName(p: ParticipantWithUser): string {
  return p.user?.full_name || p.user?.email || 'Unknown'
}

/**
 * Organizer view of the waitlist lifecycle: queue order, any pending offer
 * with its expiry, and a one-tap "offer this spot" action for whoever
 * should be next. The actual notification email is sent by the
 * `auto-chase` edge function — this panel only manages the
 * waitlist_offer_expires_at state that function (and this UI) reads.
 */
export function WaitlistPanel({ tripId, participants, isOrganizer }: WaitlistPanelProps) {
  const { showToast } = useToast()
  const queue = getWaitlistQueue(participants)
  const nextToOffer = getNextWaitlistOffer(queue)
  const offerSpot = useOfferWaitlistSpot(tripId)
  const clearOffer = useClearWaitlistOffer(tripId)

  if (queue.length === 0) {
    return <EmptyState compact icon="⏳" title="No one on the waitlist" />
  }

  return (
    <div className="space-y-2.5">
      {queue.map((entry) => (
        <div
          key={entry.participant.user_id}
          className="flex items-center gap-3 p-3 rounded-[var(--radius-md)] bg-[var(--surface-raised)] border border-[var(--border-subtle)]"
        >
          <Badge variant="neutral" size="sm">
            #{entry.position}
          </Badge>
          <UserAvatar avatarData={entry.participant.user} size="sm" />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-[var(--text-primary)] truncate">{displayName(entry.participant)}</p>
            {entry.hasActiveOffer && entry.participant.waitlist_offer_expires_at && (
              <Deadline date={entry.participant.waitlist_offer_expires_at} kind="offer" size="sm" />
            )}
            {entry.offerExpired && (
              <span className="text-xs text-danger-600">Previous offer expired, unclaimed</span>
            )}
          </div>
          {isOrganizer && (
            <>
              {entry.hasActiveOffer ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    clearOffer.mutate(entry.participant.user_id, {
                      onSuccess: () => showToast({ type: 'success', message: `Offer to ${displayName(entry.participant)} withdrawn` }),
                      onError: (err) =>
                        showToast({ type: 'error', message: 'Could not withdraw the offer', description: err instanceof Error ? err.message : undefined }),
                    })
                  }
                  isLoading={clearOffer.isPending}
                >
                  Withdraw offer
                </Button>
              ) : nextToOffer?.participant.user_id === entry.participant.user_id ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() =>
                    offerSpot.mutate(
                      { userId: entry.participant.user_id },
                      {
                        onSuccess: () => showToast({ type: 'success', message: `Spot offered to ${displayName(entry.participant)}` }),
                        onError: (err) =>
                          showToast({ type: 'error', message: 'Could not offer the spot', description: err instanceof Error ? err.message : undefined }),
                      }
                    )
                  }
                  isLoading={offerSpot.isPending}
                >
                  Offer spot
                </Button>
              ) : null}
            </>
          )}
        </div>
      ))}
    </div>
  )
}
