import { Button, Card, CapacityProgressBar, Deadline } from '../../../components/ui'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { Trip } from '../../../types'

export interface CapacityCardProps {
  trip: Trip
  participants: ParticipantWithUser[]
  myParticipant: ParticipantWithUser | null
  confirmedCount: number
  onOpenStatusModal: () => void
}

/**
 * Capacity, RSVP deadline and a way to review/change your reply. Answering
 * "Are you coming?" for the first time is a to-do in Your to-dos, so this card
 * only offers the button once you have replied.
 */
export function CapacityCard({ trip, participants, myParticipant, confirmedCount, onOpenStatusModal }: CapacityCardProps) {
  const replied = !!myParticipant?.confirmation_status && myParticipant.confirmation_status !== 'pending'
  return (
    <Card>
      <Card.Content className="space-y-3">
        <CapacityProgressBar
          confirmedCount={confirmedCount}
          capacityLimit={trip.capacity_limit}
          waitlistCount={participants.filter((p) => p.confirmation_status === 'waitlist').length}
        />
        {trip.confirmation_deadline && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-[var(--text-secondary)]">Reply by</span>
            <Deadline date={trip.confirmation_deadline} kind="deadline" size="sm" />
          </div>
        )}
        {trip.confirmation_enabled && replied && (
          <Button variant="secondary" fullWidth onClick={onOpenStatusModal}>
            {myParticipant?.confirmation_status === 'confirmed' ? 'View my reply' : 'Change my reply'}
          </Button>
        )}
      </Card.Content>
    </Card>
  )
}
