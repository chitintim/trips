import { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import { useAuth } from '../../../hooks/useAuth'
import { Badge, Button, Card, CapacityProgressBar, Deadline, Skeleton } from '../../../components/ui'
import { getTripAccentStyle } from '../../../components/layout'
import { useTrip, useParticipants } from '../../../lib/queries/useTrip'
import { useSections, useVotes } from '../../../lib/queries/usePlanning'
import { usePlaces } from '../../../lib/queries/usePlaces'
import { useBookings } from '../../../lib/queries/useBookings'
import { useSettlements } from '../../../lib/queries/useSettlements'
import { getTripStatusLabel } from '../../../lib/tripStatus'
import { computeCostBand } from '../lib/costBand'
import { buildAutoFaq } from '../lib/autoFaq'
import { formatMoney } from '../../decisions/lib/costImpact'
import { FaqAccordion } from './FaqAccordion'
import { StatusModal } from '../../people/components/StatusModal'

interface TripBriefProps {
  tripId: string
}

/**
 * Trip brief: the trip home for pre-confirmation stages. Cover with
 * per-trip accent, dates/location, organizer's markdown confirmation
 * message, estimated per-person cost band, capacity + deadline, one-tap
 * RSVP entry, and the auto-FAQ accordion. Exported as the Component in
 * src/features/brief/index.ts for the coordinator to wire as the
 * stage-aware trip home during gathering_interest/confirming_participants.
 */
export function TripBrief({ tripId }: TripBriefProps) {
  const { user } = useAuth()
  const { data: trip, isLoading: tripLoading } = useTrip(tripId)
  const { data: participants, isLoading: participantsLoading } = useParticipants(tripId)
  const { data: sections } = useSections(tripId)
  const { data: votes } = useVotes(tripId)
  const { data: places } = usePlaces(tripId)
  const { data: bookings } = useBookings(tripId)
  const { data: settlements } = useSettlements(tripId)

  const [statusModalOpen, setStatusModalOpen] = useState(false)

  const myParticipant = participants?.find((p) => p.user_id === user?.id) ?? null
  const confirmedCount = (participants || []).filter((p) => p.confirmation_status === 'confirmed').length

  const costBand = useMemo(() => {
    if (!trip || !sections) return null
    return computeCostBand(trip, sections, votes || [], confirmedCount)
  }, [trip, sections, votes, confirmedCount])

  const hasUnpaidBalance = (settlements || []).some(
    (s) => (s.from_user_id === user?.id || s.to_user_id === user?.id) && s.status !== 'confirmed'
  )

  const faqEntries = useMemo(() => {
    if (!trip) return []
    return buildAutoFaq(trip, places || [], bookings || [], costBand, hasUnpaidBalance)
  }, [trip, places, bookings, costBand, hasUnpaidBalance])

  if (tripLoading || participantsLoading || !trip) {
    return (
      <div className="p-4 space-y-4 max-w-2xl mx-auto">
        <Skeleton variant="card" height={160} />
        <Skeleton variant="list" lines={4} />
      </div>
    )
  }

  return (
    <div data-trip-accent style={getTripAccentStyle(trip.id)} className="max-w-2xl mx-auto">
      {/* Cover */}
      <div className="bg-accent-600 text-white px-4 pt-8 pb-6 sm:rounded-b-[var(--radius-xl)]">
        <Badge variant="neutral" size="sm" className="bg-white/20 text-white border-white/30 mb-2">
          {getTripStatusLabel(trip.status)}
        </Badge>
        <h1 className="text-2xl font-semibold">{trip.name}</h1>
        <p className="text-white/90 mt-1">{trip.location}</p>
        <p className="text-white/80 text-sm mt-2">
          {new Date(trip.start_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })} –{' '}
          {new Date(trip.end_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
        </p>
      </div>

      <div className="p-4 space-y-4">
        {trip.confirmation_message && (
          <Card>
            <Card.Content className="prose prose-sm max-w-none">
              <ReactMarkdown remarkPlugins={[remarkBreaks]}>{trip.confirmation_message}</ReactMarkdown>
            </Card.Content>
          </Card>
        )}

        {costBand && (
          <Card>
            <Card.Content>
              <p className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide mb-1">Estimated cost per person</p>
              <p className="text-2xl font-semibold text-[var(--text-primary)]">
                {costBand.low === costBand.high
                  ? formatMoney(costBand.low, costBand.currency)
                  : `${formatMoney(costBand.low, costBand.currency)} – ${formatMoney(costBand.high, costBand.currency)}`}
              </p>
              {trip.full_cost_link && (
                <a href={trip.full_cost_link} target="_blank" rel="noreferrer" className="text-sm text-accent-700 hover:underline">
                  See full cost breakdown →
                </a>
              )}
            </Card.Content>
          </Card>
        )}

        <Card>
          <Card.Content className="space-y-3">
            <CapacityProgressBar
              confirmedCount={confirmedCount}
              capacityLimit={trip.capacity_limit}
              waitlistCount={(participants || []).filter((p) => p.confirmation_status === 'waitlist').length}
            />
            {trip.confirmation_deadline && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-[var(--text-secondary)]">RSVP by</span>
                <Deadline date={trip.confirmation_deadline} kind="deadline" size="sm" />
              </div>
            )}
            {trip.confirmation_enabled && (
              <Button fullWidth onClick={() => setStatusModalOpen(true)}>
                {myParticipant?.confirmation_status === 'confirmed'
                  ? 'View my status'
                  : myParticipant?.confirmation_status
                    ? 'Update my status'
                    : "I'm interested"}
              </Button>
            )}
          </Card.Content>
        </Card>

        {faqEntries.length > 0 && (
          <Card>
            <Card.Header>
              <Card.Title>Common questions</Card.Title>
            </Card.Header>
            <Card.Content className="pt-0">
              <FaqAccordion entries={faqEntries} />
            </Card.Content>
          </Card>
        )}
      </div>

      {myParticipant && (
        <StatusModal
          isOpen={statusModalOpen}
          onClose={() => setStatusModalOpen(false)}
          tripId={tripId}
          participant={myParticipant}
          participants={participants || []}
          capacityLimit={trip.capacity_limit}
          confirmedCount={confirmedCount}
        />
      )}
    </div>
  )
}
