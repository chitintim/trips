import { useState, FormEvent } from 'react'
import { Modal, Button, Input, TextArea, Select } from './ui'
import { supabase } from '../lib/supabase'
import { SectionType, SectionStatus } from '../types'

interface CreatePlanningSectionModalProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  onSuccess: () => void
}

const SECTION_TYPE_OPTIONS = [
  { value: 'flights', label: 'Flights' },
  { value: 'accommodation', label: 'Accommodation' },
  { value: 'transport', label: 'Transport' },
  { value: 'equipment', label: 'Equipment (Ski/Snowboard)' },
  { value: 'activities', label: 'Activities' },
  { value: 'lessons', label: 'Lessons' },
  { value: 'insurance', label: 'Insurance' },
]

const SECTION_STATUS_OPTIONS = [
  { value: 'not_started', label: 'Not Started' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'completed', label: 'Completed' },
]

export function CreatePlanningSectionModal({
  isOpen,
  onClose,
  tripId,
  onSuccess,
}: CreatePlanningSectionModalProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [sectionType, setSectionType] = useState<SectionType>('flights')
  const [status, setStatus] = useState<SectionStatus>('not_started')
  const [allowMultipleSelections, setAllowMultipleSelections] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const resetForm = () => {
    setTitle('')
    setDescription('')
    setSectionType('flights')
    setStatus('not_started')
    setAllowMultipleSelections(false)
    setError(null)
  }

  const handleClose = () => {
    resetForm()
    onClose()
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      // Get current max order_index for this trip
      const { data: sections } = await supabase
        .from('planning_sections')
        .select('order_index')
        .eq('trip_id', tripId)
        .order('order_index', { ascending: false })
        .limit(1)

      const nextOrderIndex = sections && sections.length > 0 ? sections[0].order_index + 1 : 0

      const { error: insertError } = await supabase
        .from('planning_sections')
        .insert({
          trip_id: tripId,
          title,
          description: description || null,
          section_type: sectionType,
          status,
          allow_multiple_selections: allowMultipleSelections,
          order_index: nextOrderIndex,
        })

      if (insertError) {
        console.error('Error creating section:', insertError)
        setError(insertError.message)
        setLoading(false)
        return
      }

      setLoading(false)
      onSuccess()
      handleClose()
    } catch (err) {
      console.error('Unexpected error:', err)
      setError('An unexpected error occurred')
      setLoading(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Create Planning Section">
      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-sm">
            {error}
          </div>
        )}

        {/* Title */}
        <Input
          label="Section Title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={loading}
          required
          placeholder="e.g., Outbound Flights, Accommodation, Ski Rental"
        />

        {/* Section Type */}
        <Select
          label="Section Type"
          value={sectionType}
          onChange={(e) => setSectionType(e.target.value as SectionType)}
          disabled={loading}
          options={SECTION_TYPE_OPTIONS}
          helperText="Choose the category that best fits this section"
        />

        {/* Description */}
        <TextArea
          label="Description (Optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={loading}
          placeholder="Add any additional details or instructions..."
          rows={3}
        />

        {/* Allow Multiple Selections */}
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="allow-multiple"
            checked={allowMultipleSelections}
            onChange={(e) => setAllowMultipleSelections(e.target.checked)}
            disabled={loading}
            className="mt-1 h-4 w-4 rounded border-gray-300 text-sky-600 focus:ring-sky-500"
          />
          <label htmlFor="allow-multiple" className="flex-1">
            <div className="font-medium text-gray-900">Allow Multiple Selections</div>
            <div className="text-sm text-gray-600">
              If enabled, users can select multiple options (like attending multiple dinners).
              If disabled, selecting a new option will deselect the previous one (like choosing one flight).
            </div>
          </label>
        </div>

        {/* Status */}
        <Select
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as SectionStatus)}
          disabled={loading}
          options={SECTION_STATUS_OPTIONS}
          helperText="Track the progress of this planning section"
        />

        {/* Buttons */}
        <div className="flex gap-3 justify-end pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" isLoading={loading}>
            Create Section
          </Button>
        </div>
      </form>
    </Modal>
  )
}
