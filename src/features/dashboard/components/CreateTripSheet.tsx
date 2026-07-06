import { useEffect } from 'react'
import { Modal, Button, Input, useToast, ConfirmDiscardSheet } from '../../../components/ui'
import { useCreateTrip } from '../../../lib/queries/useTrip'
import { useFormDraft } from '../../../lib/forms/useFormDraft'
import { useUnsavedChangesGuard } from '../../../lib/forms/useUnsavedChangesGuard'
import { useNavigate } from 'react-router-dom'

interface CreateTripFormValues {
  name: string
  location: string
  startDate: string
  endDate: string
  isPublic: boolean
}

const EMPTY_VALUES: CreateTripFormValues = {
  name: '',
  location: '',
  startDate: '',
  endDate: '',
  isPublic: false,
}

interface CreateTripSheetProps {
  isOpen: boolean
  onClose: () => void
}

/** Create-trip sheet for the member dashboard. Fresh state every open (create-modal semantics — never seeds from a previous submission). */
export function CreateTripSheet({ isOpen, onClose }: CreateTripSheetProps) {
  const navigate = useNavigate()
  const createTrip = useCreateTrip()
  const { showToast } = useToast()

  const { values, setValues, updateField, clearDraft } = useFormDraft<CreateTripFormValues>('create-trip', EMPTY_VALUES)

  useEffect(() => {
    if (isOpen) setValues(EMPTY_VALUES)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const isDirty = JSON.stringify(values) !== JSON.stringify(EMPTY_VALUES)
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isDirty)
  const handleClose = () => confirmClose(onClose)

  const handleSubmit = async () => {
    if (!values.name.trim() || !values.location.trim() || !values.startDate || !values.endDate) {
      showToast({ type: 'error', message: 'Please fill in all fields' })
      return
    }
    if (new Date(values.endDate) < new Date(values.startDate)) {
      showToast({ type: 'error', message: 'End date must be after start date' })
      return
    }

    try {
      const tripId = await createTrip.mutateAsync({
        name: values.name.trim(),
        location: values.location.trim(),
        start_date: values.startDate,
        end_date: values.endDate,
        status: 'gathering_interest',
        is_public: values.isPublic,
      })
      showToast({ type: 'success', message: 'Trip created' })
      clearDraft()
      onClose()
      navigate(`/${tripId}`)
    } catch (err) {
      showToast({ type: 'error', message: 'Could not create trip', description: (err as Error).message })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="md" title="Create a new trip">
      <div className="space-y-4">
        <Input label="Trip name" value={values.name} onChange={(e) => updateField('name', e.target.value)} placeholder="Chamonix 2027" required autoFocus />
        <Input label="Location" value={values.location} onChange={(e) => updateField('location', e.target.value)} placeholder="Chamonix, France" required />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Start date" type="date" value={values.startDate} onChange={(e) => updateField('startDate', e.target.value)} required />
          <Input label="End date" type="date" value={values.endDate} onChange={(e) => updateField('endDate', e.target.value)} required />
        </div>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={values.isPublic}
            onChange={(e) => updateField('isPublic', e.target.checked)}
            className="mt-1 w-5 h-5 accent-accent-600"
          />
          <span className="text-sm text-[var(--text-primary)]">
            Make this trip publicly visible (anyone with an account can see and ask to join)
          </span>
        </label>

        <div className="flex justify-end gap-3 pt-4 border-t border-[var(--border-subtle)]">
          <Button variant="outline" onClick={handleClose} disabled={createTrip.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} isLoading={createTrip.isPending}>
            Create trip
          </Button>
        </div>
      </div>

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
