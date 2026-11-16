import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import { Badge, Card, UserAvatar } from '../../../components/ui'
import { getTripStatusLabel } from '../../../lib/tripStatus'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { Trip, TripStatus } from '../../../types'

/**
 * The trip brief, decomposed into importable sections (UX_REDESIGN.md Part 2:
 * Today's invitee/pre-commit layout composes these — cover hero, organizer
 * message, RSVP card, who's-in row) so the brief is a set of
 * building blocks rather than one monolithic tab.
 */

export function BriefCover({ trip, statusOverride }: { trip: Trip; statusOverride?: TripStatus }) {
  return (
    <div className="bg-accent-600 text-white px-4 pt-8 pb-6 sm:rounded-[var(--radius-xl)]">
      <Badge variant="neutral" size="sm" className="bg-white/20 text-white border-white/30 mb-2">
        {getTripStatusLabel(statusOverride ?? trip.status)}
      </Badge>
      <h1 className="text-2xl font-semibold">{trip.name}</h1>
      <p className="text-white/90 mt-1">{trip.location}</p>
      <p className="text-white/80 text-sm mt-2">
        {new Date(trip.start_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })} –{' '}
        {new Date(trip.end_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
      </p>
    </div>
  )
}

export function OrganizerMessageCard({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <Card>
      <Card.Content className="prose prose-sm max-w-none">
        <ReactMarkdown remarkPlugins={[remarkBreaks]}>{message}</ReactMarkdown>
      </Card.Content>
    </Card>
  )
}

/** Who's-in avatar row: confirmed people (then conditional), capped with a +N overflow. */
export function WhosInRow({ participants, max = 8 }: { participants: ParticipantWithUser[]; max?: number }) {
  const confirmed = participants.filter((p) => p.confirmation_status === 'confirmed')
  const conditional = participants.filter((p) => p.confirmation_status === 'conditional')
  const people = [...confirmed, ...conditional]
  if (people.length === 0) return null
  const shown = people.slice(0, max)
  const overflow = people.length - shown.length
  return (
    <Card>
      <Card.Content>
        <p className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide mb-2">
          Who's in ({confirmed.length} going{conditional.length > 0 ? `, ${conditional.length} not sure` : ''})
        </p>
        <div className="flex items-center gap-1.5 flex-wrap">
          {shown.map((p) => (
            <div key={p.user_id} title={p.user?.full_name ?? undefined}>
              <UserAvatar avatarData={p.user} size="sm" />
            </div>
          ))}
          {overflow > 0 && <span className="text-sm text-[var(--text-muted)] ml-1">+{overflow}</span>}
        </div>
      </Card.Content>
    </Card>
  )
}
