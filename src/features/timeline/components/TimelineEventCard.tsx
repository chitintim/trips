import { useState } from 'react'
import { Button, UserAvatar } from '../../../components/ui'
import { PlaceChip, PlacePicker } from '../../places'
import { CATEGORY_CONFIG, formatTimeRange } from '../lib/categoryConfig'
import type { TimelineEvent, TimelineEventCategory } from '../../../types'
import type { Tables } from '../../../types/database.types'

interface ParticipantLike {
  user_id: string
  user?: {
    full_name?: string | null
    email?: string
    avatar_data?: unknown
  } | null
}

export interface TimelineEventCardProps {
  event: TimelineEvent
  tripId: string
  isOrganizer: boolean
  isNextUp?: boolean
  participants: ParticipantLike[]
  onEdit?: (event: TimelineEvent) => void
  onDelete?: (event: TimelineEvent) => void
  /** Called once a place has been pinned via the inline "pin it" affordance. */
  onPlacePicked?: (event: TimelineEvent, place: Tables<'places'>) => void
}

/**
 * A single timeline event card: category icon/accent, time-or-all-day,
 * location (PlaceChip when pinned, else plain text + organizer "pin it"
 * affordance), participant avatars for a subset invite, and organizer
 * edit/delete actions. Expands in place to show description/metadata.
 */
export function TimelineEventCard({
  event,
  tripId,
  isOrganizer,
  isNextUp = false,
  participants,
  onEdit,
  onDelete,
  onPlacePicked,
}: TimelineEventCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [placePickerOpen, setPlacePickerOpen] = useState(false)

  const category = event.category as TimelineEventCategory
  const style = CATEGORY_CONFIG[category] ?? CATEGORY_CONFIG.other
  const timeRange = formatTimeRange(event.all_day, event.start_time, event.end_time)

  // Participant avatars: null participant_ids means "everyone", so we only
  // surface avatars when the event is scoped to a subset of the trip.
  const eventParticipants = event.participant_ids
    ? participants.filter((p) => event.participant_ids!.includes(p.user_id))
    : participants
  const isScopedSubset = !!event.participant_ids && eventParticipants.length < participants.length

  const metadata = (event.metadata || {}) as Record<string, unknown>
  const hasDetails = !!event.description || Object.keys(metadata).length > 0

  return (
    <div
      className={`relative flex gap-3 rounded-[var(--radius-lg)] border p-3 pl-0 transition-colors ${
        isNextUp
          ? 'border-accent-400 bg-accent-50 dark:bg-accent-950/40'
          : 'border-[var(--border-subtle)] bg-[var(--surface-raised)] hover:border-[var(--border-default)]'
      }`}
    >
      {/* Category accent bar */}
      <span className={`w-1 shrink-0 self-stretch rounded-full ${style.accentClassName}`} aria-hidden="true" />

      <div className="min-w-0 flex-1 py-0.5 pr-1" onClick={() => hasDetails && setExpanded((v) => !v)} role={hasDetails ? 'button' : undefined}>
        <div className="flex flex-wrap items-center gap-2">
          {isNextUp && (
            <span className="rounded-[var(--radius-full)] bg-accent-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
              Next up
            </span>
          )}
          {timeRange && (
            <span className="rounded-[var(--radius-sm)] bg-[var(--surface-sunken)] px-2 py-0.5 text-xs font-medium text-[var(--text-secondary)]">
              {timeRange}
            </span>
          )}
          <span className={`rounded-[var(--radius-sm)] px-1.5 py-0.5 text-xs font-medium ${style.badgeClassName}`}>
            {style.emoji} {style.label}
          </span>
        </div>

        <h4 className="mt-1 font-medium text-[var(--text-primary)]">{event.title}</h4>

        {/* Location: PlaceChip when pinned, else plain text + organizer pin affordance */}
        {event.place_id ? (
          <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
            <PlaceChip place={{ name: event.location || 'Place', lat: null, lng: null, google_place_url: null, google_maps_link: null }} compact />
          </div>
        ) : event.location ? (
          <div className="mt-1 flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
            <span aria-hidden="true">📍</span>
            <span className="truncate">{event.location}</span>
            {isOrganizer && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setPlacePickerOpen(true)
                }}
                className="shrink-0 text-xs font-medium text-accent-600 underline decoration-dotted hover:text-accent-700 dark:text-accent-400"
              >
                pin it
              </button>
            )}
          </div>
        ) : null}

        {/* Participant avatars for subset invites */}
        {isScopedSubset && (
          <div className="mt-1.5 flex items-center gap-1.5">
            <div className="flex -space-x-1.5">
              {eventParticipants.slice(0, 5).map((p) => (
                <UserAvatar key={p.user_id} avatarData={p.user} size="xs" />
              ))}
            </div>
            {eventParticipants.length > 5 && (
              <span className="text-xs text-[var(--text-muted)]">+{eventParticipants.length - 5}</span>
            )}
          </div>
        )}

        {expanded && hasDetails && (
          <div className="mt-3 space-y-2 border-t border-[var(--border-subtle)] pt-3">
            {event.description && <p className="whitespace-pre-wrap text-sm text-[var(--text-secondary)]">{event.description}</p>}
            {Object.keys(metadata).length > 0 && (
              <div className="space-y-1 text-xs text-[var(--text-muted)]">
                {Object.entries(metadata).map(([key, value]) => (
                  <div key={key}>
                    <span className="font-medium">{key}:</span> {String(value)}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {isOrganizer && (
        <div className="flex shrink-0 flex-col gap-1 self-start">
          <Button variant="ghost" size="sm" onClick={() => onEdit?.(event)} className="!px-1.5 !py-1 text-[var(--text-muted)]">
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onDelete?.(event)} className="!px-1.5 !py-1 text-[var(--text-muted)] hover:text-danger-600">
            Delete
          </Button>
        </div>
      )}

      <PlacePicker
        isOpen={placePickerOpen}
        onClose={() => setPlacePickerOpen(false)}
        tripId={tripId}
        title={`Pin "${event.title}"`}
        onPicked={(place) => {
          setPlacePickerOpen(false)
          onPlacePicked?.(event, place)
        }}
      />
    </div>
  )
}
