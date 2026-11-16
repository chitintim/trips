import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import { Badge, Card, UserAvatar } from '../../../components/ui'
import { getTripStatusLabel } from '../../../lib/tripStatus'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import { buildWhosIn } from '../lib/whosIn'
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

const RING: Record<string, string> = {
  going: 'ring-success-500',
  'not-sure': 'ring-warn-500',
  'no-reply': 'ring-neutral-300 dark:ring-neutral-600',
  waitlist: 'ring-accent-500',
  'not-going': 'ring-danger-500',
  everyone: 'ring-transparent',
}

/**
 * Who's-coming card: everyone grouped by their reply (Going first), each with
 * a status ring, first name beneath, and an accessible "Name — Reply" label.
 * The label and count carry the meaning, never colour alone. Tapping opens the
 * People space.
 */
export function WhosInRow({
  participants,
  trackingOn = true,
  onOpenPeople,
}: {
  participants: ParticipantWithUser[]
  trackingOn?: boolean
  onOpenPeople?: () => void
}) {
  const model = buildWhosIn(
    participants.map((p) => ({ id: p.user_id, name: p.user?.full_name, status: p.confirmation_status, active: p.active })),
    trackingOn,
  )
  if (model.total === 0) return null
  const byId = new Map(participants.map((p) => [p.user_id, p]))
  const body = (
    <>
      <h3 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide mb-2">{model.heading}</h3>
      <div className="space-y-3">
        {model.groups.map((g) => (
          <div key={g.chip}>
            {g.chip !== 'everyone' && (
              <p className="text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
                {g.label} · {g.count}
              </p>
            )}
            <ul className="flex flex-wrap gap-x-2 gap-y-2">
              {g.people.map((person) => {
                const reply = g.chip === 'everyone' ? null : g.label
                const full = reply ? `${person.fullName} — ${reply}` : person.fullName
                return (
                  <li key={person.id} className="flex w-14 flex-col items-center" title={full}>
                    <UserAvatar
                      avatarData={byId.get(person.id)?.user}
                      size="md"
                      alt={full}
                      className={`ring-2 ring-offset-1 ring-offset-[var(--surface-raised,transparent)] ${RING[g.chip]}`}
                    />
                    <span aria-hidden="true" className="mt-1 w-full truncate text-center text-[11px] text-[var(--text-secondary)]">
                      {person.firstName}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
    </>
  )
  return (
    <Card>
      <Card.Content>
        {onOpenPeople ? (
          <button type="button" onClick={onOpenPeople} className="block w-full text-left press-scale">
            {body}
          </button>
        ) : (
          body
        )}
      </Card.Content>
    </Card>
  )
}
