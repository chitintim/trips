import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import { Modal, Button, Input, TextArea, Select, useToast } from '../../../components/ui'
import { useTrip, useUpdateTrip, useParticipants } from '../../../lib/queries/useTrip'
import { useResetConfirmations } from '../../../lib/queries/useConfirmations'
import { ResetConfirmationsSheet } from './ResetConfirmationsSheet'
import { countResettableConfirmations, describeResetCount } from '../lib/resetConfirmations'
import { useFormDraft } from '../../../lib/forms/useFormDraft'
import { useUnsavedChangesGuard } from '../../../lib/forms/useUnsavedChangesGuard'
import { ConfirmDiscardSheet } from '../../../components/ui'

const CURRENCY_OPTIONS = ['GBP', 'EUR', 'USD', 'JPY', 'CHF', 'AUD', 'CAD'].map((c) => ({ value: c, label: c }))

interface ConfirmationSettingsSheetProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  isOrganizer: boolean
}

interface SettingsFormValues {
  confirmationEnabled: boolean
  confirmationMessage: string
  estimatedCost: string
  currency: string
  fullCostLink: string
  capacityLimit: string
  confirmationDeadline: string
  showPreview: boolean
}

const EMPTY_VALUES: SettingsFormValues = {
  confirmationEnabled: false,
  confirmationMessage: '',
  estimatedCost: '',
  currency: 'GBP',
  fullCostLink: '',
  capacityLimit: '',
  confirmationDeadline: '',
  showPreview: false,
}

/**
 * Organizer confirmation-settings sheet, ported from the legacy
 * ConfirmationSettingsPanel onto the new ui kit as a Modal sheet rather
 * than an always-visible panel. Fields map 1:1 onto the trips columns:
 * confirmation_enabled, confirmation_message, estimated_accommodation_cost
 * + accommodation_cost_currency, full_cost_link, capacity_limit,
 * confirmation_deadline.
 */
export function ConfirmationSettingsSheet({ isOpen, onClose, tripId, isOrganizer }: ConfirmationSettingsSheetProps) {
  const { data: trip } = useTrip(tripId)
  const updateTrip = useUpdateTrip(tripId)
  const { showToast } = useToast()
  const { data: participants } = useParticipants(tripId)
  const resetConfirmations = useResetConfirmations(tripId)
  const [resetOpen, setResetOpen] = useState(false)
  // Only meaningful when re-opening confirmation that was closed with answers still on file.
  const [reopenMode, setReopenMode] = useState<'keep' | 'fresh'>('keep')
  const existingCount = countResettableConfirmations(participants ?? [])
  const isReopening = !!trip && !trip.confirmation_enabled && existingCount > 0

  const draftKey = `confirmation-settings:${tripId}`
  // This sheet only ever edits the trip's existing confirmation settings
  // (no create mode) -- draft persistence is disabled so a stale autosave
  // from a previous open can never override the live trip record (Form &
  // Flow Standard §5.2).
  const { values, setValues, updateField, clearDraft } = useFormDraft<SettingsFormValues>(draftKey, EMPTY_VALUES, {
    enabled: false,
  })

  useEffect(() => {
    if (isOpen && trip) {
      setReopenMode('keep')
      setValues({
        confirmationEnabled: trip.confirmation_enabled || false,
        confirmationMessage: trip.confirmation_message || '',
        estimatedCost: trip.estimated_accommodation_cost?.toString() || '',
        currency: trip.accommodation_cost_currency || 'GBP',
        fullCostLink: trip.full_cost_link || '',
        capacityLimit: trip.capacity_limit?.toString() || '',
        confirmationDeadline: trip.confirmation_deadline ? trip.confirmation_deadline.split('T')[0] : '',
        showPreview: false,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, trip?.id])

  const seedForDirtyCheck: SettingsFormValues = trip
    ? {
        confirmationEnabled: trip.confirmation_enabled || false,
        confirmationMessage: trip.confirmation_message || '',
        estimatedCost: trip.estimated_accommodation_cost?.toString() || '',
        currency: trip.accommodation_cost_currency || 'GBP',
        fullCostLink: trip.full_cost_link || '',
        capacityLimit: trip.capacity_limit?.toString() || '',
        confirmationDeadline: trip.confirmation_deadline ? trip.confirmation_deadline.split('T')[0] : '',
        showPreview: values.showPreview,
      }
    : EMPTY_VALUES
  const isDirty = JSON.stringify(values) !== JSON.stringify(seedForDirtyCheck)
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isOpen && isDirty)
  const handleClose = () => confirmClose(onClose)

  if (!isOrganizer) return null

  const handleSave = async () => {
    if (values.confirmationEnabled) {
      if (!values.confirmationMessage.trim()) {
        showToast({ type: 'error', message: 'Please provide a confirmation message' })
        return
      }
      if (values.capacityLimit && (parseInt(values.capacityLimit, 10) <= 0 || isNaN(parseInt(values.capacityLimit, 10)))) {
        showToast({ type: 'error', message: 'Capacity limit must be a positive number' })
        return
      }
      if (values.estimatedCost && (parseFloat(values.estimatedCost) <= 0 || isNaN(parseFloat(values.estimatedCost)))) {
        showToast({ type: 'error', message: 'Estimated cost must be a positive number' })
        return
      }
    }

    try {
      // Re-opening with "start fresh": wipe the old round first, so a failed
      // reset aborts before the trip is switched back on.
      if (isReopening && values.confirmationEnabled && reopenMode === 'fresh') {
        await resetConfirmations.mutateAsync({})
      }
      await updateTrip.mutateAsync({
        confirmation_enabled: values.confirmationEnabled,
        confirmation_message: values.confirmationEnabled ? values.confirmationMessage.trim() : null,
        estimated_accommodation_cost: values.confirmationEnabled && values.estimatedCost ? parseFloat(values.estimatedCost) : null,
        accommodation_cost_currency: values.confirmationEnabled && values.estimatedCost ? values.currency : null,
        full_cost_link: values.confirmationEnabled && values.fullCostLink.trim() ? values.fullCostLink.trim() : null,
        capacity_limit: values.confirmationEnabled && values.capacityLimit ? parseInt(values.capacityLimit, 10) : null,
        confirmation_deadline: values.confirmationEnabled && values.confirmationDeadline ? new Date(values.confirmationDeadline).toISOString() : null,
      })
      showToast({ type: 'success', message: 'Confirmation settings saved' })
      clearDraft()
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not save settings', description: (err as Error).message })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="lg" title="Confirmation settings">
      <div className="space-y-5">
        <div className="flex items-start gap-4">
          <div className="flex-1">
            <h3 className="font-medium text-[var(--text-primary)] mb-1">Enable confirmation tracking</h3>
            <p className="text-sm text-[var(--text-secondary)]">
              Turn this on when you need firm commitments before booking. People answer "Are you coming?" — "I'm in" means they share the costs you book.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={values.confirmationEnabled}
            aria-label="Enable confirmation tracking"
            onClick={() => updateField('confirmationEnabled', !values.confirmationEnabled)}
            className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-accent-500 ${
              values.confirmationEnabled ? 'bg-accent-600' : 'bg-[var(--surface-sunken)]'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform transition duration-200 ${
                values.confirmationEnabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {isReopening && values.confirmationEnabled && (
          <fieldset className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-3 space-y-2">
            <legend className="px-1 text-sm font-medium text-[var(--text-primary)]">
              {describeResetCount(existingCount)} from the previous round
            </legend>
            <label className="flex items-start gap-2 text-sm text-[var(--text-primary)]">
              <input type="radio" name="reopen-mode" className="mt-0.5" checked={reopenMode === 'keep'} onChange={() => setReopenMode('keep')} />
              <span>Keep them (people stay Going)</span>
            </label>
            <label className="flex items-start gap-2 text-sm text-[var(--text-primary)]">
              <input type="radio" name="reopen-mode" className="mt-0.5" checked={reopenMode === 'fresh'} onChange={() => setReopenMode('fresh')} />
              <span>Start fresh (everyone goes back to No reply yet; the reset sends no email, but normal reminders resume)</span>
            </label>
          </fieldset>
        )}

        {values.confirmationEnabled && (
          <div className="space-y-5">
            <div>
              <TextArea
                label="Confirmation message (markdown)"
                value={values.confirmationMessage}
                onChange={(e) => updateField('confirmationMessage', e.target.value)}
                rows={5}
                maxLength={1000}
                showCount
                helperText={'Shown on the trip brief and when someone says "I\'m in" — explain what you\'ll book and what it costs.'}
              />
              <button
                type="button"
                onClick={() => updateField('showPreview', !values.showPreview)}
                className="mt-1.5 text-xs text-accent-700 hover:underline"
              >
                {values.showPreview ? 'Hide preview' : 'Show preview'}
              </button>
              {values.showPreview && (
                <div className="mt-2 p-3 bg-[var(--surface-sunken)] rounded-[var(--radius-md)] prose prose-sm max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkBreaks]}>{values.confirmationMessage || '*Nothing to preview yet*'}</ReactMarkdown>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Estimated accommodation cost per person"
                type="number"
                value={values.estimatedCost}
                onChange={(e) => updateField('estimatedCost', e.target.value)}
                placeholder="500"
              />
              <Select
                label="Currency"
                value={values.currency}
                onChange={(e) => updateField('currency', e.target.value)}
                options={CURRENCY_OPTIONS}
              />
            </div>

            <Input
              label="Full cost breakdown link (optional)"
              type="url"
              value={values.fullCostLink}
              onChange={(e) => updateField('fullCostLink', e.target.value)}
              placeholder="https://..."
            />

            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Capacity limit (optional)"
                type="number"
                value={values.capacityLimit}
                onChange={(e) => updateField('capacityLimit', e.target.value)}
                placeholder="Unlimited"
              />
              <Input
                label="Reply-by deadline (optional)"
                type="date"
                value={values.confirmationDeadline}
                onChange={(e) => updateField('confirmationDeadline', e.target.value)}
              />
            </div>
          </div>
        )}

        {trip?.confirmation_enabled && existingCount > 0 && (
          <div className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-3">
            <p className="text-sm text-[var(--text-secondary)]">
              Booking fell through? Clear {describeResetCount(existingCount)} and start a new round.
            </p>
            <Button variant="outline" onClick={() => setResetOpen(true)}>
              Reset confirmations
            </Button>
          </div>
        )}

        <div className="flex justify-end gap-3 pt-4 border-t border-[var(--border-subtle)]">
          <Button variant="outline" onClick={handleClose} disabled={updateTrip.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSave} isLoading={updateTrip.isPending || resetConfirmations.isPending}>
            Save settings
          </Button>
        </div>
      </div>

      <ResetConfirmationsSheet isOpen={resetOpen} onClose={() => setResetOpen(false)} tripId={tripId} />

      <ConfirmDiscardSheet
        isOpen={guardProps.showConfirm}
        onKeep={guardProps.onKeep}
        onDiscard={() => {
          clearDraft()
          guardProps.onDiscard()
        }}
      />
    </Modal>
  )
}
