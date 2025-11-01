import { useState, useEffect, FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { Card, Button, EmptyState, Spinner } from './ui'
import { TripNoteWithUser, NoteType } from '../types'

interface TripNotesSectionProps {
  tripId: string
  isOrganizer: boolean
}

const NOTE_TYPE_CONFIG = {
  announcement: { label: 'Announcement', icon: '📢', color: 'bg-orange-100 text-orange-800' },
  note: { label: 'Note', icon: '📝', color: 'bg-blue-100 text-blue-800' },
  reminder: { label: 'Reminder', icon: '⏰', color: 'bg-yellow-100 text-yellow-800' },
  question: { label: 'Question', icon: '❓', color: 'bg-purple-100 text-purple-800' },
  info: { label: 'Info', icon: 'ℹ️', color: 'bg-green-100 text-green-800' },
} as const

export function TripNotesSection({ tripId, isOrganizer }: TripNotesSectionProps) {
  const { user } = useAuth()
  const [notes, setNotes] = useState<TripNoteWithUser[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [showAddForm, setShowAddForm] = useState(false)
  const [noteType, setNoteType] = useState<NoteType>('note')
  const [content, setContent] = useState('')
  const [filterType, setFilterType] = useState<NoteType | 'all'>('all')

  useEffect(() => {
    fetchNotes()
  }, [tripId])

  const fetchNotes = async () => {
    setLoading(true)

    const { data, error } = await supabase
      .from('trip_notes')
      .select(`
        *,
        user:user_id (
          id,
          full_name,
          email,
          avatar_data
        )
      `)
      .eq('trip_id', tripId)
      .order('created_at', { ascending: false })

    if (!error && data) {
      setNotes(data as TripNoteWithUser[])
    }

    setLoading(false)
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!user || !content.trim()) return

    setSubmitting(true)

    const { error } = await supabase
      .from('trip_notes')
      .insert({
        trip_id: tripId,
        user_id: user.id,
        note_type: noteType,
        content: content.trim(),
      })

    if (error) {
      alert(`Error creating note: ${error.message}`)
      setSubmitting(false)
      return
    }

    setContent('')
    setNoteType('note')
    setShowAddForm(false)
    setSubmitting(false)
    fetchNotes()
  }

  const handleDelete = async (noteId: string) => {
    if (!window.confirm('Delete this note?')) return

    const { error } = await supabase
      .from('trip_notes')
      .delete()
      .eq('id', noteId)

    if (error) {
      alert(`Error deleting note: ${error.message}`)
      return
    }

    fetchNotes()
  }

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`

    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
    })
  }

  if (loading) {
    return (
      <Card>
        <Card.Content className="py-12 flex justify-center">
          <Spinner size="lg" />
        </Card.Content>
      </Card>
    )
  }

  // Filter notes based on selected type
  const filteredNotes = filterType === 'all'
    ? notes
    : notes.filter(note => note.note_type === filterType)

  return (
    <Card>
      <Card.Header>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Card.Title>Notes & Announcements</Card.Title>
              <Card.Description>
                Share information, reminders, and questions with the group
              </Card.Description>
            </div>
            {!showAddForm && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => setShowAddForm(true)}
              >
                + Add Note
              </Button>
            )}
          </div>

          {/* Filter Dropdown */}
          {notes.length > 0 && (
            <div className="flex items-center gap-2">
              <label htmlFor="note-filter" className="text-sm font-medium text-gray-700">
                Filter:
              </label>
              <select
                id="note-filter"
                value={filterType}
                onChange={(e) => setFilterType(e.target.value as NoteType | 'all')}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-sky-500 focus:border-sky-500 bg-white"
              >
                <option value="all">All Types ({notes.length})</option>
                {(Object.keys(NOTE_TYPE_CONFIG) as NoteType[]).map((type) => {
                  const config = NOTE_TYPE_CONFIG[type]
                  const count = notes.filter(n => n.note_type === type).length
                  if (count === 0) return null
                  return (
                    <option key={type} value={type}>
                      {config.icon} {config.label} ({count})
                    </option>
                  )
                })}
              </select>
              {filterType !== 'all' && (
                <button
                  onClick={() => setFilterType('all')}
                  className="text-xs text-sky-600 hover:text-sky-700 underline"
                >
                  Clear filter
                </button>
              )}
            </div>
          )}
        </div>
      </Card.Header>
      <Card.Content>
        {/* Add Note Form */}
        {showAddForm && (
          <form onSubmit={handleSubmit} className="mb-6 p-4 border border-gray-200 rounded-lg bg-gray-50">
            <div className="space-y-4">
              {/* Note Type Selector */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Type
                </label>
                <div className="flex flex-wrap gap-2">
                  {(Object.keys(NOTE_TYPE_CONFIG) as NoteType[]).map((type) => {
                    const config = NOTE_TYPE_CONFIG[type]
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => setNoteType(type)}
                        className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                          noteType === type
                            ? config.color + ' ring-2 ring-offset-2 ring-gray-400'
                            : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                        }`}
                      >
                        {config.icon} {config.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Content */}
              <div>
                <label htmlFor="note-content" className="block text-sm font-medium text-gray-700 mb-1">
                  Message
                </label>
                <textarea
                  id="note-content"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  disabled={submitting}
                  required
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-sky-500 focus:border-sky-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  placeholder="Type your message..."
                />
              </div>

              {/* Buttons */}
              <div className="flex gap-2 justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setShowAddForm(false)
                    setContent('')
                    setNoteType('note')
                  }}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  isLoading={submitting}
                >
                  Post Note
                </Button>
              </div>
            </div>
          </form>
        )}

        {/* Notes List */}
        {notes.length === 0 ? (
          <EmptyState
            icon="💬"
            title="No notes yet"
            description="Be the first to add a note or announcement for this trip"
          />
        ) : filteredNotes.length === 0 ? (
          <EmptyState
            icon="🔍"
            title="No notes found"
            description={`No ${filterType} notes to display`}
          />
        ) : (
          <div className="space-y-3">
            {filteredNotes.map((note) => {
              const config = NOTE_TYPE_CONFIG[note.note_type]
              const isOwnNote = user?.id === note.user_id
              const canDelete = isOwnNote || isOrganizer

              return (
                <div
                  key={note.id}
                  className="p-4 border border-gray-200 rounded-lg bg-white hover:shadow-sm transition-shadow"
                >
                  {/* Header */}
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${config.color}`}>
                        {config.icon} {config.label}
                      </span>
                      <div className="flex items-center gap-2">
                        <div
                          className="w-6 h-6 rounded-full flex items-center justify-center text-xs flex-shrink-0"
                          style={{
                            backgroundColor: (note.user?.avatar_data as any)?.bgColor || '#0ea5e9',
                          }}
                        >
                          <span className="relative">
                            {(note.user?.avatar_data as any)?.emoji || '😊'}
                            {(note.user?.avatar_data as any)?.accessory && (
                              <span className="absolute -top-0.5 left-1/2 -translate-x-1/2 text-[0.5rem]">
                                {(note.user?.avatar_data as any)?.accessory}
                              </span>
                            )}
                          </span>
                        </div>
                        <span className="text-sm font-medium text-gray-900">
                          {note.user?.full_name || note.user?.email || 'Unknown'}
                        </span>
                      </div>
                      <span className="text-xs text-gray-500">
                        {formatTimestamp(note.created_at)}
                      </span>
                    </div>
                    {canDelete && (
                      <button
                        onClick={() => handleDelete(note.id)}
                        className="text-xs text-red-600 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 transition-colors flex-shrink-0"
                        title="Delete note"
                      >
                        Delete
                      </button>
                    )}
                  </div>

                  {/* Content */}
                  <p className="text-sm text-gray-700 whitespace-pre-wrap break-words">
                    {note.content}
                  </p>
                </div>
              )
            })}
          </div>
        )}
      </Card.Content>
    </Card>
  )
}
