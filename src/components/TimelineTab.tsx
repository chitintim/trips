import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { Trip, TimelineEvent, TimelineEventCategory, TimelineEventInsert } from '../types'
import { Button, Card, Spinner, EmptyState, Modal, Input, Select, TextArea } from './ui'
import { TimelineEventCard } from './TimelineEventCard'

interface ParticipantWithUser {
  user_id: string
  role: string
  user: {
    full_name?: string | null
    email?: string
    avatar_data?: any
  }
}

interface TimelineTabProps {
  trip: Trip
  participants: ParticipantWithUser[]
}

const CATEGORY_OPTIONS = [
  { value: 'flight', label: '✈️ Flight' },
  { value: 'accommodation', label: '🏨 Accommodation' },
  { value: 'transport', label: '🚐 Transport' },
  { value: 'activity', label: '⛷️ Activity' },
  { value: 'dining', label: '🍽️ Dining' },
  { value: 'transfer', label: '🚌 Transfer' },
  { value: 'meeting_point', label: '📍 Meeting Point' },
  { value: 'free_time', label: '🌴 Free Time' },
  { value: 'other', label: '📌 Other' },
]

function generateDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = []
  const current = new Date(startDate + 'T00:00:00')
  const end = new Date(endDate + 'T00:00:00')
  while (current <= end) {
    dates.push(current.toISOString().split('T')[0])
    current.setDate(current.getDate() + 1)
  }
  return dates
}

function formatDayHeader(dateStr: string, tripStartDate: string): { dayNum: number; label: string } {
  const date = new Date(dateStr + 'T00:00:00')
  const start = new Date(tripStartDate + 'T00:00:00')
  const dayNum = Math.floor((date.getTime() - start.getTime()) / (86400000)) + 1
  const label = date.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'short' })
  return { dayNum, label }
}

export function TimelineTab({ trip, participants }: TimelineTabProps) {
  const { user } = useAuth()
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [isOrganizer, setIsOrganizer] = useState(false)
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [editingEvent, setEditingEvent] = useState<TimelineEvent | null>(null)
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(new Set())

  // Form state
  const [formDate, setFormDate] = useState('')
  const [formTitle, setFormTitle] = useState('')
  const [formCategory, setFormCategory] = useState<TimelineEventCategory>('other')
  const [formStartTime, setFormStartTime] = useState('')
  const [formEndTime, setFormEndTime] = useState('')
  const [formLocation, setFormLocation] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formAllDay, setFormAllDay] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchEvents()
    checkOrganizerStatus()
  }, [trip.id, user])

  useEffect(() => {
    // Real-time subscription
    const channel = supabase
      .channel(`trip_timeline_realtime:${trip.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'trip_timeline_events',
          filter: `trip_id=eq.${trip.id}`,
        },
        () => {
          fetchEvents()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [trip.id])

  const fetchEvents = async () => {
    const { data, error } = await supabase
      .from('trip_timeline_events')
      .select('*')
      .eq('trip_id', trip.id)
      .order('event_date')
      .order('start_time')
      .order('sort_order')

    if (error) {
      console.error('Error fetching timeline events:', error)
    } else {
      setEvents(data || [])
    }
    setLoading(false)
  }

  const checkOrganizerStatus = async () => {
    if (!user) return

    const { data: userData } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()
    const isSystemAdmin = userData?.role === 'admin'

    const { data: participantData } = await supabase
      .from('trip_participants')
      .select('role')
      .eq('trip_id', trip.id)
      .eq('user_id', user.id)
      .single()

    const isTripOrganizer = participantData?.role === 'organizer'
    const isTripCreator = trip.created_by === user.id

    setIsOrganizer(isSystemAdmin || isTripCreator || isTripOrganizer)
  }

  const handleAddEvent = (dateStr?: string) => {
    setEditingEvent(null)
    setFormDate(dateStr || trip.start_date)
    setFormTitle('')
    setFormCategory('other')
    setFormStartTime('')
    setFormEndTime('')
    setFormLocation('')
    setFormDescription('')
    setFormAllDay(false)
    setAddModalOpen(true)
  }

  const handleEditEvent = (event: TimelineEvent) => {
    setEditingEvent(event)
    setFormDate(event.event_date)
    setFormTitle(event.title)
    setFormCategory(event.category as TimelineEventCategory)
    setFormStartTime(event.start_time || '')
    setFormEndTime(event.end_time || '')
    setFormLocation(event.location || '')
    setFormDescription(event.description || '')
    setFormAllDay(event.all_day || false)
    setAddModalOpen(true)
  }

  const handleDeleteEvent = async (event: TimelineEvent) => {
    if (!window.confirm(`Delete "${event.title}"?`)) return

    const { error } = await supabase
      .from('trip_timeline_events')
      .delete()
      .eq('id', event.id)

    if (error) {
      alert(`Error deleting event: ${error.message}`)
    }
  }

  const handleSaveEvent = async () => {
    if (!user || !formTitle.trim() || !formDate) return
    setSaving(true)

    if (editingEvent) {
      const { error } = await supabase
        .from('trip_timeline_events')
        .update({
          event_date: formDate,
          title: formTitle.trim(),
          category: formCategory,
          start_time: formStartTime || null,
          end_time: formEndTime || null,
          location: formLocation.trim() || null,
          description: formDescription.trim() || null,
          all_day: formAllDay,
          updated_at: new Date().toISOString(),
        })
        .eq('id', editingEvent.id)

      if (error) {
        alert(`Error updating event: ${error.message}`)
      }
    } else {
      const newEvent: TimelineEventInsert = {
        trip_id: trip.id,
        event_date: formDate,
        title: formTitle.trim(),
        category: formCategory,
        start_time: formStartTime || null,
        end_time: formEndTime || null,
        location: formLocation.trim() || null,
        description: formDescription.trim() || null,
        all_day: formAllDay,
        created_by: user.id,
      }

      const { error } = await supabase
        .from('trip_timeline_events')
        .insert(newEvent)

      if (error) {
        alert(`Error creating event: ${error.message}`)
      }
    }

    setSaving(false)
    setAddModalOpen(false)
  }

  const toggleDay = (dateStr: string) => {
    setCollapsedDays(prev => {
      const next = new Set(prev)
      if (next.has(dateStr)) {
        next.delete(dateStr)
      } else {
        next.add(dateStr)
      }
      return next
    })
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    )
  }

  const allDates = generateDateRange(trip.start_date, trip.end_date)
  const eventsByDate = new Map<string, TimelineEvent[]>()
  for (const event of events) {
    const existing = eventsByDate.get(event.event_date) || []
    existing.push(event)
    eventsByDate.set(event.event_date, existing)
  }

  const today = new Date().toISOString().split('T')[0]

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Timeline</h2>
          <p className="text-sm text-gray-500">
            {events.length} event{events.length !== 1 ? 's' : ''} across {allDates.length} day{allDates.length !== 1 ? 's' : ''}
          </p>
        </div>
        {isOrganizer && (
          <Button variant="primary" size="sm" onClick={() => handleAddEvent()}>
            + Add Event
          </Button>
        )}
      </div>

      {/* Day-by-day view */}
      {allDates.length === 0 ? (
        <Card className="!p-8">
          <EmptyState
            icon="📋"
            title="No dates set"
            description="Set trip dates to see the timeline."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {allDates.map(dateStr => {
            const { dayNum, label } = formatDayHeader(dateStr, trip.start_date)
            const dayEvents = eventsByDate.get(dateStr) || []
            const isCollapsed = collapsedDays.has(dateStr)
            const isToday = dateStr === today
            const isPast = dateStr < today

            return (
              <div key={dateStr} className={`${isToday ? 'ring-2 ring-sky-300 rounded-lg' : ''}`}>
                {/* Day header */}
                <button
                  onClick={() => toggleDay(dateStr)}
                  className={`w-full flex items-center justify-between px-4 py-2.5 rounded-t-lg transition-colors ${
                    isToday
                      ? 'bg-sky-50 hover:bg-sky-100'
                      : isPast
                        ? 'bg-gray-50 hover:bg-gray-100'
                        : 'bg-white hover:bg-gray-50 border border-gray-200'
                  } ${isCollapsed ? 'rounded-b-lg' : ''}`}
                >
                  <div className="flex items-center gap-3">
                    <svg
                      className={`w-4 h-4 text-gray-400 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <span className={`font-semibold ${isToday ? 'text-sky-700' : 'text-gray-900'}`}>
                      Day {dayNum}
                    </span>
                    <span className={`text-sm ${isToday ? 'text-sky-600' : 'text-gray-500'}`}>
                      {label}
                    </span>
                    {isToday && (
                      <span className="text-xs bg-sky-500 text-white px-2 py-0.5 rounded-full font-medium">
                        Today
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {dayEvents.length > 0 && (
                      <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full">
                        {dayEvents.length}
                      </span>
                    )}
                    {isOrganizer && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleAddEvent(dateStr) }}
                        className="text-gray-400 hover:text-sky-500 transition-colors"
                        title="Add event to this day"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                      </button>
                    )}
                  </div>
                </button>

                {/* Day events */}
                {!isCollapsed && (
                  <div className={`px-4 py-3 space-y-2 ${
                    isToday ? 'bg-sky-50/50' : isPast ? 'bg-gray-50/50' : 'bg-white border-x border-b border-gray-200 rounded-b-lg'
                  } ${isToday || isPast ? 'rounded-b-lg' : ''}`}>
                    {dayEvents.length === 0 ? (
                      <p className="text-sm text-gray-400 py-2 text-center">No events planned</p>
                    ) : (
                      dayEvents.map(event => (
                        <TimelineEventCard
                          key={event.id}
                          event={event}
                          isOrganizer={isOrganizer}
                          participants={participants as any}
                          onEdit={handleEditEvent}
                          onDelete={handleDeleteEvent}
                        />
                      ))
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Add/Edit Event Modal */}
      <Modal
        isOpen={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        title={editingEvent ? 'Edit Event' : 'Add Event'}
      >
        <div className="space-y-4">
          <Input
            label="Title"
            value={formTitle}
            onChange={(e) => setFormTitle(e.target.value)}
            placeholder="e.g., Lunch at Mountain Hut"
          />

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Date"
              type="date"
              value={formDate}
              onChange={(e) => setFormDate(e.target.value)}
              min={trip.start_date}
              max={trip.end_date}
            />
            <Select
              label="Category"
              value={formCategory}
              onChange={(e) => setFormCategory(e.target.value as TimelineEventCategory)}
              options={CATEGORY_OPTIONS}
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="allDay"
              checked={formAllDay}
              onChange={(e) => setFormAllDay(e.target.checked)}
              className="rounded border-gray-300"
            />
            <label htmlFor="allDay" className="text-sm text-gray-700">All day event</label>
          </div>

          {!formAllDay && (
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Start Time"
                type="time"
                value={formStartTime}
                onChange={(e) => setFormStartTime(e.target.value)}
              />
              <Input
                label="End Time"
                type="time"
                value={formEndTime}
                onChange={(e) => setFormEndTime(e.target.value)}
              />
            </div>
          )}

          <Input
            label="Location"
            value={formLocation}
            onChange={(e) => setFormLocation(e.target.value)}
            placeholder="e.g., Chalet Restaurant, Verbier"
          />

          <TextArea
            label="Description"
            value={formDescription}
            onChange={(e) => setFormDescription(e.target.value)}
            placeholder="Additional details, booking references..."
            rows={3}
          />

          <div className="flex gap-2 pt-2">
            <Button variant="outline" onClick={() => setAddModalOpen(false)} className="flex-1">
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSaveEvent}
              disabled={!formTitle.trim() || !formDate || saving}
              className="flex-1"
            >
              {saving ? 'Saving...' : editingEvent ? 'Update' : 'Add Event'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
