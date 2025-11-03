import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Card, Button, Input, TextArea, Select } from './ui'
import { getSupportedCurrencies, type Currency } from '../lib/currency'

// ============================================================================
// TYPES
// ============================================================================

interface ConfirmationSettingsPanelProps {
  tripId: string
  isOrganizer: boolean
  onUpdate?: () => void
}

// ============================================================================
// COMPONENT
// ============================================================================

export function ConfirmationSettingsPanel({
  tripId,
  isOrganizer,
  onUpdate,
}: ConfirmationSettingsPanelProps) {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showPreview, setShowPreview] = useState(false)

  // Settings state
  const [confirmationEnabled, setConfirmationEnabled] = useState(false)
  const [confirmationMessage, setConfirmationMessage] = useState('')
  const [estimatedCost, setEstimatedCost] = useState('')
  const [currency, setCurrency] = useState<Currency>('GBP')
  const [fullCostLink, setFullCostLink] = useState('')
  const [capacityLimit, setCapacityLimit] = useState('')
  const [confirmationDeadline, setConfirmationDeadline] = useState('')

  useEffect(() => {
    fetchSettings()
  }, [tripId])

  const fetchSettings = async () => {
    setLoading(true)

    try {
      const { data, error } = await supabase
        .from('trips')
        .select('confirmation_enabled, confirmation_message, estimated_accommodation_cost, accommodation_cost_currency, full_cost_link, capacity_limit, confirmation_deadline')
        .eq('id', tripId)
        .single()

      if (error) throw error

      if (data) {
        setConfirmationEnabled(data.confirmation_enabled || false)
        setConfirmationMessage(data.confirmation_message || '')
        setEstimatedCost(data.estimated_accommodation_cost?.toString() || '')
        setCurrency((data.accommodation_cost_currency as Currency) || 'GBP')
        setFullCostLink(data.full_cost_link || '')
        setCapacityLimit(data.capacity_limit?.toString() || '')
        setConfirmationDeadline(data.confirmation_deadline ? data.confirmation_deadline.split('T')[0] : '')
      }
    } catch (error: any) {
      console.error('Error fetching confirmation settings:', error)
      alert(error.message || 'Failed to load confirmation settings')
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    if (!isOrganizer) {
      alert('Only trip organizers can update confirmation settings')
      return
    }

    // Validation
    if (confirmationEnabled) {
      if (!confirmationMessage.trim()) {
        alert('Please provide a confirmation message explaining what participants need to know')
        return
      }

      if (capacityLimit && (parseInt(capacityLimit) <= 0 || isNaN(parseInt(capacityLimit)))) {
        alert('Capacity limit must be a positive number')
        return
      }

      if (estimatedCost && (parseFloat(estimatedCost) <= 0 || isNaN(parseFloat(estimatedCost)))) {
        alert('Estimated cost must be a positive number')
        return
      }
    }

    setSaving(true)

    try {
      const update: any = {
        confirmation_enabled: confirmationEnabled,
        confirmation_message: confirmationEnabled ? confirmationMessage.trim() : null,
        estimated_accommodation_cost: confirmationEnabled && estimatedCost ? parseFloat(estimatedCost) : null,
        accommodation_cost_currency: confirmationEnabled && estimatedCost ? currency : null,
        full_cost_link: confirmationEnabled && fullCostLink.trim() ? fullCostLink.trim() : null,
        capacity_limit: confirmationEnabled && capacityLimit ? parseInt(capacityLimit) : null,
        confirmation_deadline: confirmationEnabled && confirmationDeadline ? new Date(confirmationDeadline).toISOString() : null,
      }

      const { error } = await supabase
        .from('trips')
        .update(update)
        .eq('id', tripId)

      if (error) throw error

      alert('Confirmation settings saved successfully!')
      if (onUpdate) onUpdate()
    } catch (error: any) {
      console.error('Error saving confirmation settings:', error)
      alert(error.message || 'Failed to save confirmation settings')
    } finally {
      setSaving(false)
    }
  }

  if (!isOrganizer) {
    return (
      <Card>
        <Card.Content className="py-8 text-center">
          <p className="text-gray-500">Only trip organizers can configure confirmation settings</p>
        </Card.Content>
      </Card>
    )
  }

  if (loading) {
    return (
      <Card>
        <Card.Content className="py-8 text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
          <p className="text-sm text-gray-500 mt-2">Loading settings...</p>
        </Card.Content>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      {/* Enable/Disable Confirmation System */}
      <Card>
        <Card.Header>
          <Card.Title>Confirmation System</Card.Title>
          <Card.Description>
            Manage participant confirmations for this trip
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <div className="flex items-start gap-4">
            <div className="flex-1">
              <h3 className="font-medium text-gray-900 mb-1">Enable confirmation tracking</h3>
              <p className="text-sm text-gray-600">
                When enabled, participants can update their commitment status (confirmed, interested, conditional, etc.)
              </p>
            </div>
            <button
              onClick={() => setConfirmationEnabled(!confirmationEnabled)}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 ${
                confirmationEnabled ? 'bg-primary-600' : 'bg-gray-200'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  confirmationEnabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {confirmationEnabled && (
            <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex items-start gap-2">
                <svg className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                    clipRule="evenodd"
                  />
                </svg>
                <div className="flex-1 text-sm text-blue-900">
                  <p className="font-medium mb-1">Confirmation system is active</p>
                  <p className="text-blue-800">
                    Participants will see a confirmation dashboard in the People tab where they can update their status.
                    Configure the settings below to customize the experience.
                  </p>
                </div>
              </div>
            </div>
          )}
        </Card.Content>
      </Card>

      {/* Confirmation Settings (only show when enabled) */}
      {confirmationEnabled && (
        <>
          {/* Confirmation Message */}
          <Card>
            <Card.Header>
              <Card.Title>Confirmation Message</Card.Title>
              <Card.Description>
                Explain what participants need to know before confirming
              </Card.Description>
            </Card.Header>
            <Card.Content>
              <TextArea
                value={confirmationMessage}
                onChange={(e) => setConfirmationMessage(e.target.value)}
                placeholder="Example: We need firm commitments by Jan 15th to book the chalet. Please only confirm if you're 100% sure you can make it, as cancellations will affect the whole group's cost."
                rows={4}
                maxLength={1000}
              />
              <div className="flex items-center justify-between mt-2">
                <p className="text-xs text-gray-500">
                  {confirmationMessage.length}/1000 characters
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowPreview(!showPreview)}
                >
                  {showPreview ? 'Hide' : 'Show'} Preview
                </Button>
              </div>

              {/* Preview */}
              {showPreview && confirmationMessage.trim() && (
                <div className="mt-4 p-4 border border-gray-200 rounded-lg bg-gray-50">
                  <div className="flex items-start gap-3">
                    <div className="text-2xl">📢</div>
                    <div className="flex-1">
                      <h4 className="font-semibold text-gray-900 text-sm mb-1">Important Information</h4>
                      <p className="text-sm text-gray-700 whitespace-pre-wrap">{confirmationMessage}</p>
                    </div>
                  </div>
                </div>
              )}
            </Card.Content>
          </Card>

          {/* Cost Information */}
          <Card>
            <Card.Header>
              <Card.Title>Cost Information</Card.Title>
              <Card.Description>
                Help participants understand the financial commitment (optional)
              </Card.Description>
            </Card.Header>
            <Card.Content>
              <div className="space-y-4">
                {/* Estimated Cost */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="sm:col-span-2">
                    <label htmlFor="estimated-cost" className="block text-sm font-medium text-gray-700 mb-2">
                      Estimated cost per person
                    </label>
                    <Input
                      id="estimated-cost"
                      type="number"
                      step="0.01"
                      min="0"
                      value={estimatedCost}
                      onChange={(e) => setEstimatedCost(e.target.value)}
                      placeholder="500.00"
                    />
                  </div>
                  <div>
                    <label htmlFor="currency" className="block text-sm font-medium text-gray-700 mb-2">
                      Currency
                    </label>
                    <Select
                      id="currency"
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value as Currency)}
                      options={getSupportedCurrencies().map((c) => ({
                        value: c,
                        label: c,
                      }))}
                    />
                  </div>
                </div>

                {/* Full Cost Link */}
                <div>
                  <label htmlFor="full-cost-link" className="block text-sm font-medium text-gray-700 mb-2">
                    Full cost breakdown link (optional)
                  </label>
                  <Input
                    id="full-cost-link"
                    type="url"
                    value={fullCostLink}
                    onChange={(e) => setFullCostLink(e.target.value)}
                    placeholder="https://docs.google.com/spreadsheets/..."
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Link to a detailed cost breakdown (e.g., Google Sheet, shared document)
                  </p>
                </div>

                {/* Preview */}
                {(estimatedCost || fullCostLink.trim()) && (
                  <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg">
                    <p className="text-xs font-medium text-gray-700 mb-2">How this will appear:</p>
                    <div className="flex items-center gap-4 text-sm">
                      {estimatedCost && (
                        <span className="text-gray-600">
                          Estimated cost:{' '}
                          <span className="font-semibold text-gray-900">
                            {currency} {parseFloat(estimatedCost).toFixed(2)}
                          </span>
                        </span>
                      )}
                      {fullCostLink.trim() && (
                        <a
                          href={fullCostLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary-600 hover:text-primary-700 underline"
                        >
                          View full costs →
                        </a>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </Card.Content>
          </Card>

          {/* Capacity & Deadline */}
          <Card>
            <Card.Header>
              <Card.Title>Capacity & Deadlines</Card.Title>
              <Card.Description>
                Set limits and important dates (optional)
              </Card.Description>
            </Card.Header>
            <Card.Content>
              <div className="space-y-4">
                {/* Capacity Limit */}
                <div>
                  <label htmlFor="capacity-limit" className="block text-sm font-medium text-gray-700 mb-2">
                    Maximum confirmed participants
                  </label>
                  <Input
                    id="capacity-limit"
                    type="number"
                    min="1"
                    value={capacityLimit}
                    onChange={(e) => setCapacityLimit(e.target.value)}
                    placeholder="e.g., 12 (based on chalet capacity)"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    When this limit is reached, new confirmations will automatically go to the waitlist
                  </p>
                </div>

                {/* Confirmation Deadline */}
                <div>
                  <label htmlFor="confirmation-deadline" className="block text-sm font-medium text-gray-700 mb-2">
                    Confirmation deadline
                  </label>
                  <input
                    id="confirmation-deadline"
                    type="date"
                    value={confirmationDeadline}
                    onChange={(e) => setConfirmationDeadline(e.target.value)}
                    min={new Date().toISOString().split('T')[0]}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    The date by which participants should confirm their attendance
                  </p>
                </div>

                {/* Preview */}
                {(capacityLimit || confirmationDeadline) && (
                  <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg">
                    <p className="text-xs font-medium text-gray-700 mb-2">How this will appear:</p>
                    <div className="space-y-2">
                      {capacityLimit && (
                        <div className="text-sm text-gray-700">
                          <span className="font-medium">Capacity:</span> 0/{capacityLimit} confirmed
                        </div>
                      )}
                      {confirmationDeadline && (
                        <div className="text-sm text-warning-700 font-medium">
                          Confirmation deadline:{' '}
                          {new Date(confirmationDeadline).toLocaleDateString('en-GB', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </Card.Content>
          </Card>
        </>
      )}

      {/* Save Button */}
      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={fetchSettings} disabled={saving}>
          Reset
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save Settings'}
        </Button>
      </div>
    </div>
  )
}
