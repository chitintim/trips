import { useState } from 'react'
import { TimelineEvent, TimelineEventCategory } from '../types'
import { Button } from './ui'

const CATEGORY_EMOJI: Record<TimelineEventCategory, string> = {
  flight: '✈️',
  accommodation: '🏨',
  transport: '🚐',
  activity: '⛷️',
  dining: '🍽️',
  transfer: '🚌',
  meeting_point: '📍',
  free_time: '🌴',
  other: '📌',
}

const CATEGORY_LABEL: Record<TimelineEventCategory, string> = {
  flight: 'Flight',
  accommodation: 'Accommodation',
  transport: 'Transport',
  activity: 'Activity',
  dining: 'Dining',
  transfer: 'Transfer',
  meeting_point: 'Meeting Point',
  free_time: 'Free Time',
  other: 'Other',
}

function formatTime(time: string | null): string {
  if (!time) return ''
  const [h, m] = time.split(':')
  const hour = parseInt(h)
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour
  return `${displayHour}:${m} ${ampm}`
}

interface TimelineEventCardProps {
  event: TimelineEvent
  isOrganizer: boolean
  participants: Array<{
    user_id: string
    user: {
      full_name?: string | null
      avatar_data?: any
    }
  }>
  onEdit?: (event: TimelineEvent) => void
  onDelete?: (event: TimelineEvent) => void
}

export function TimelineEventCard({ event, isOrganizer, participants, onEdit, onDelete }: TimelineEventCardProps) {
  const [expanded, setExpanded] = useState(false)

  const category = event.category as TimelineEventCategory
  const emoji = CATEGORY_EMOJI[category] || '📌'
  const label = CATEGORY_LABEL[category] || 'Other'

  const timeRange = event.all_day
    ? 'All day'
    : event.start_time
      ? event.end_time
        ? `${formatTime(event.start_time)} - ${formatTime(event.end_time)}`
        : formatTime(event.start_time)
      : ''

  // Get participant avatars for this event
  const eventParticipants = event.participant_ids
    ? participants.filter(p => event.participant_ids!.includes(p.user_id))
    : participants // null = all participants

  const metadata = (event.metadata || {}) as Record<string, any>
  const hasDetails = event.description || event.location || Object.keys(metadata).length > 0

  return (
    <div
      className={`bg-white border border-gray-200 rounded-lg p-3 hover:border-gray-300 transition-colors ${hasDetails ? 'cursor-pointer' : ''}`}
      onClick={() => hasDetails && setExpanded(!expanded)}
    >
      <div className="flex items-start gap-3">
        {/* Category emoji */}
        <span className="text-xl flex-shrink-0 mt-0.5">{emoji}</span>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {timeRange && (
              <span className="text-xs font-medium text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
                {timeRange}
              </span>
            )}
            <span className="text-xs text-gray-400">{label}</span>
          </div>
          <h4 className="font-medium text-gray-900 mt-1">{event.title}</h4>

          {event.location && !expanded && (
            <p className="text-sm text-gray-500 mt-0.5 flex items-center gap-1">
              <span className="text-xs">📍</span> {event.location}
            </p>
          )}

          {/* Participant avatars */}
          {event.participant_ids && eventParticipants.length < participants.length && (
            <div className="flex items-center gap-1 mt-1.5">
              <div className="flex -space-x-1.5">
                {eventParticipants.slice(0, 5).map(p => (
                  <div
                    key={p.user_id}
                    className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] border border-white"
                    style={{ backgroundColor: p.user.avatar_data?.bgColor || '#0ea5e9' }}
                    title={p.user.full_name || undefined}
                  >
                    {p.user.avatar_data?.emoji || '😊'}
                  </div>
                ))}
              </div>
              {eventParticipants.length > 5 && (
                <span className="text-xs text-gray-400">+{eventParticipants.length - 5}</span>
              )}
            </div>
          )}
        </div>

        {/* Organizer actions */}
        {isOrganizer && (
          <div className="flex gap-1 flex-shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => { e.stopPropagation(); onEdit?.(event) }}
              className="!px-1.5 !py-1 text-gray-400 hover:text-gray-600"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => { e.stopPropagation(); onDelete?.(event) }}
              className="!px-1.5 !py-1 text-gray-400 hover:text-red-500"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </Button>
          </div>
        )}
      </div>

      {/* Expanded details */}
      {expanded && hasDetails && (
        <div className="mt-3 pt-3 border-t border-gray-100 space-y-2">
          {event.location && (
            <p className="text-sm text-gray-600 flex items-center gap-1.5">
              <span>📍</span> {event.location}
            </p>
          )}
          {event.description && (
            <p className="text-sm text-gray-600 whitespace-pre-wrap">{event.description}</p>
          )}
          {Object.keys(metadata).length > 0 && (
            <div className="text-xs text-gray-400 space-y-1">
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
  )
}
