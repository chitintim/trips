import { useState, FormEvent, useEffect } from 'react'
import { Modal, Button, Input, TextArea, Select } from './ui'
import { supabase } from '../lib/supabase'
import { OptionStatus, PriceType } from '../types'

interface CreateOptionModalProps {
  isOpen: boolean
  onClose: () => void
  sectionId: string
  onSuccess: () => void
  /**
   * Optional: Option to edit (if provided, modal is in edit mode)
   */
  option?: any
}

const OPTION_STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'available', label: 'Available' },
  { value: 'booking', label: 'Booking' },
  { value: 'booked', label: 'Booked' },
  { value: 'cancelled', label: 'Cancelled' },
]

const PRICE_TYPE_OPTIONS = [
  { value: 'per_person_fixed', label: 'Per Person (Fixed)' },
  { value: 'total_split', label: 'Total Split Between Selectors' },
  { value: 'per_person_tiered', label: 'Per Person (Tiered Options)' },
]

interface MetadataField {
  key: string
  value: string
}

export function CreateOptionModal({
  isOpen,
  onClose,
  sectionId,
  onSuccess,
  option,
}: CreateOptionModalProps) {
  const isEditMode = !!option

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [link, setLink] = useState('')
  const [price, setPrice] = useState('')
  const [currency, setCurrency] = useState('EUR')
  const [priceType, setPriceType] = useState<PriceType>('per_person_fixed')
  const [status, setStatus] = useState<OptionStatus>('available')
  const [locked, setLocked] = useState(false)
  const [metadataFields, setMetadataFields] = useState<MetadataField[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Populate form when editing
  useEffect(() => {
    if (option && isOpen) {
      setTitle(option.title || '')
      setDescription(option.description || '')
      setLink(option.metadata?.link || '')
      setPrice(option.price ? String(option.price) : '')
      setCurrency(option.currency || 'EUR')
      setPriceType(option.price_type || 'per_person_fixed')
      setStatus(option.status || 'available')
      setLocked(option.locked || false)

      // Convert metadata object to array of fields (exclude link as it has its own field)
      const metadata = option.metadata || {}
      const { link: _link, ...otherMetadata } = metadata
      const fields = Object.entries(otherMetadata).map(([key, value]) => ({
        key,
        value: String(value)
      }))
      setMetadataFields(fields)
    }
  }, [option, isOpen])

  const resetForm = () => {
    setTitle('')
    setDescription('')
    setLink('')
    setPrice('')
    setCurrency('EUR')
    setPriceType('per_person_fixed')
    setStatus('available')
    setLocked(false)
    setMetadataFields([])
    setError(null)
  }

  const handleClose = () => {
    resetForm()
    onClose()
  }

  const handleAddMetadataField = () => {
    setMetadataFields([...metadataFields, { key: '', value: '' }])
  }

  const handleRemoveMetadataField = (index: number) => {
    setMetadataFields(metadataFields.filter((_, i) => i !== index))
  }

  const handleMetadataChange = (index: number, field: 'key' | 'value', value: string) => {
    const updated = [...metadataFields]
    updated[index][field] = value
    setMetadataFields(updated)
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      // Build metadata object from key-value pairs
      const metadata: Record<string, string> = {}

      // Add link to metadata if provided
      if (link.trim()) {
        metadata.link = link.trim()
      }

      // Add other metadata fields
      metadataFields.forEach((field) => {
        if (field.key.trim()) {
          metadata[field.key.trim()] = field.value
        }
      })

      const optionData = {
        section_id: sectionId,
        title,
        description: description || null,
        price: price ? parseFloat(price) : null,
        currency: price ? currency : null,
        price_type: priceType,
        status,
        locked,
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
      }

      if (isEditMode && option) {
        // UPDATE existing option
        const { error: updateError } = await supabase
          .from('options')
          .update(optionData)
          .eq('id', option.id)

        if (updateError) {
          console.error('Error updating option:', updateError)
          setError(updateError.message)
          setLoading(false)
          return
        }
      } else {
        // INSERT new option
        const { error: insertError } = await supabase
          .from('options')
          .insert(optionData)

        if (insertError) {
          console.error('Error creating option:', insertError)
          setError(insertError.message)
          setLoading(false)
          return
        }
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
    <Modal isOpen={isOpen} onClose={handleClose} title={isEditMode ? "Edit Option" : "Create Option"}>
      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-sm">
            {error}
          </div>
        )}

        {/* Title */}
        <Input
          label="Option Title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={loading}
          required
          placeholder="e.g., British Airways BA123, Chalet Alpine"
        />

        {/* Description (Markdown) */}
        <div>
          <TextArea
            label="Description (Markdown Supported)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={loading}
            placeholder="Use markdown for formatting:&#10;## Heading&#10;- Bullet points&#10;**Bold text**&#10;[Links](https://example.com)&#10;&#10;Press Enter for new lines!"
            rows={6}
            helperText="Supports markdown formatting. Press Enter for line breaks."
          />
        </div>

        {/* Link (Optional) */}
        <Input
          label="Link (Optional)"
          type="url"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          disabled={loading}
          placeholder="https://example.com/menu"
          helperText="e.g., menu, booking page, details, or location map"
        />

        {/* Pricing */}
        <div className="space-y-4 border-t pt-4">
          <h3 className="font-semibold text-gray-900">Pricing</h3>

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Price (Optional)"
              type="number"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              disabled={loading}
              placeholder="0.00"
            />
            <Input
              label="Currency"
              type="text"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              disabled={loading || !price}
              placeholder="EUR"
            />
          </div>

          <Select
            label="Price Type"
            value={priceType}
            onChange={(e) => setPriceType(e.target.value as PriceType)}
            disabled={loading || !price}
            options={PRICE_TYPE_OPTIONS}
            helperText={
              priceType === 'total_split'
                ? 'Total price will be divided by number of people who select this'
                : priceType === 'per_person_tiered'
                  ? 'Users can choose from different price tiers (configure in metadata)'
                  : 'Each person pays the same fixed price'
            }
          />
        </div>

        {/* Metadata Fields */}
        <div className="space-y-4 border-t pt-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-gray-900">Metadata (Optional)</h3>
            <Button
              type="button"
              variant="outline"
              onClick={handleAddMetadataField}
              disabled={loading}
              size="sm"
            >
              + Add Field
            </Button>
          </div>
          <p className="text-sm text-gray-600">
            Add custom key-value pairs for flight times, locations, equipment details, etc.
          </p>

          {metadataFields.map((field, index) => (
            <div key={index} className="flex gap-2">
              <Input
                type="text"
                value={field.key}
                onChange={(e) => handleMetadataChange(index, 'key', e.target.value)}
                disabled={loading}
                placeholder="Key (e.g., departure_time)"
                className="flex-1"
              />
              <Input
                type="text"
                value={field.value}
                onChange={(e) => handleMetadataChange(index, 'value', e.target.value)}
                disabled={loading}
                placeholder="Value (e.g., 10:30 AM)"
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => handleRemoveMetadataField(index)}
                disabled={loading}
                size="sm"
              >
                Remove
              </Button>
            </div>
          ))}
        </div>

        {/* Status and Lock */}
        <div className="space-y-4 border-t pt-4">
          <Select
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as OptionStatus)}
            disabled={loading}
            options={OPTION_STATUS_OPTIONS}
          />

          <div className="flex items-start gap-3">
            <input
              type="checkbox"
              id="locked"
              checked={locked}
              onChange={(e) => setLocked(e.target.checked)}
              disabled={loading}
              className="mt-1 h-4 w-4 rounded border-gray-300 text-sky-600 focus:ring-sky-500"
            />
            <label htmlFor="locked" className="flex-1">
              <div className="font-medium text-gray-900">Lock Option</div>
              <div className="text-sm text-gray-600">
                Prevent users from changing their selection for this option
              </div>
            </label>
          </div>
        </div>

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
            {isEditMode ? 'Save Changes' : 'Create Option'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
