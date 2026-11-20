import { Button, Card, CapacityProgressBar, Deadline } from '../../../components/ui'
import { rsvpButtonLabel } from '../../people/lib/rsvpButtonLabel'
import { useMyRsvpStanding } from '../../people/lib/useRsvpStanding'
import { standingReplacesAnswerButton } from '../../people/lib/peopleSummary'
import { replyByEnd } from '../../people/lib/replyBy'
import type { RsvpAnswer } from '../../people/lib/rsvpAnswers'
import { RsvpStandingNotice } from '../../people/components/RsvpStandingNotice'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { Trip } from '../../../types'

export interface CapacityCardProps {
  trip: Trip
  participants: ParticipantWithUser[]
  myParticipant: ParticipantWithUser | null
  confirmedCount: number
  /** Opens the RSVP sheet; the optional answer is preselected. */
  onOpenStatusModal: (answer?: RsvpAnswer) => void
}

/**
 * Capacity, RSVP deadline and a way to review/change your reply. Answering
 * "Are you coming?" for the first time is a to-do in Your to-dos, so this card
 * only offers the button once you have replied.
 */
export function CapacityCard({ trip, participants, myParticipant, confirmedCount, onOpenStatusModal }: CapacityCardProps) {
  const standing = useMyRsvpStanding(trip, participants, myParticipant?.user_id)
    const replied = !!myParticipant?.confirmation_status && myParticipant.confirmation_status !== 'pending'
  return (
    <Card>
      <Card.Content className="space-y-3">
        <CapacityProgressBar
          confirmedCount={confirmedCount}
          capacityLimit={trip.capacity_limit}
          invitedCount={participants.filter((p) => p.active !== false).length}
          waitlistCount={participants.filter((p) => p.confirmation_status === 'waitlist').length}
        />
        {trip.confirmation_deadline && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-[var(--text-secondary)]">Reply by</span>
            <Deadline date={replyByEnd(trip.confirmation_deadline) ?? trip.confirmation_deadline} kind="deadline" size="sm" />
          </div>
        )}
        {standing && (
          <RsvpStandingNotice standing={standing} tripName={trip.name} onAnswer={(a) => onOpenStatusModal(a)} />
        )}
        {trip.confirmation_enabled && replied && !(standing && standingReplacesAnswerButton(standing)) && (
          <Button variant="secondary" fullWidth onClick={() => onOpenStatusModal()}>
            {rsvpButtonLabel(myParticipant?.confirmation_status)}
          </Button>
        )}
      </Card.Content>
    </Card>
  )
}
