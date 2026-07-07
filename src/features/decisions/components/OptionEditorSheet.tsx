import { useEffect } from 'react'
import { Modal, Button, Input, TextArea, Select, SegmentedControl, useToast } from '../../../components/ui'
import { useCreateOption, useUpdateOption, useDeleteOption } from '../../../lib/queries/usePlanning'
import { useFormDraft } from '../../../lib/forms/useFormDraft'
import { useUnsavedChangesGuard } from '../../../lib/forms/useUnsavedChangesGuard'
import { ConfirmDiscardSheet } from '../../../components/ui'
import { useTripActivityLog } from '../../organizer/lib/activity'
import type { Option } from '../../../types'
import type { Enums } from '../../../types/database.types'
import type { OptionDraft } from '../../../shared/contracts'

type PriceType = Enums<'price_type'>

const PRICE_TYPE_OPTIONS: Array<{ value: PriceType; label: string }> = [
  { value: 'per_person_fixed', label: 'Per person' },
  { value: 'total_split', label: 'Total (split across group)' },
  { value: 'per_person_tiered', label: 'Per person (tiered/matrix)' },
]

interface OptionFormValues {
  title: string
  description: string
  price: string
  currency: string
  priceType: PriceType
  gridRow: string
  gridColumn: string
}

const EMPTY_VALUES: OptionFormValues = {
  title: '',
  description: '',
  price: '',
  currency: 'GBP',
  priceType: 'per_person_fixed',
  gridRow: '',
  gridColumn: '',
}

function fromOption(option: Option | null): OptionFormValues {
  if (!option) return EMPTY_VALUES
  const meta = (option.metadata && typeof option.metadata === 'object' && !Array.isArray(option.metadata) ? option.metadata : {}) as Record<string, unknown>
  return {
    title: option.title,
    description: option.description || '',
    price: option.price?.toString() || '',
    currency: option.currency || 'GBP',
    priceType: option.price_type,
    gridRow: typeof meta.grid_row === 'string' ? meta.grid_row : '',
    gridColumn: typeof meta.grid_column === 'string' ? meta.grid_column : '',
  }
}

/** Seed values from a paste-a-link OptionDraft (see IngestResult contract). */
function fromDraft(draft: OptionDraft): OptionFormValues {
  return {
    title: draft.title,
    description: draft.description || '',
    price: draft.price?.toString() || '',
    currency: draft.currency || 'GBP',
    priceType: (draft.price_type as PriceType) || 'per_person_fixed',
    gridRow: '',
    gridColumn: '',
  }
}

interface OptionEditorSheetProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  sectionId: string
  /** Null = creating a new option. Present = editing. */
  option: Option | null
  /** Pre-fill from a paste-a-link draft when creating (ignored when editing). */
  prefillDraft?: OptionDraft | null
}

export function OptionEditorSheet({ isOpen, onClose, tripId, sectionId, option, prefillDraft }: OptionEditorSheetProps) {
  const createOption = useCreateOption(tripId)
  const updateOption = useUpdateOption(tripId)
  const deleteOption = useDeleteOption(tripId)
  const logActivity = useTripActivityLog(tripId)
  const { showToast } = useToast()

  const isEditing = !!option
  const draftKey = isEditing ? `option-editor:${option!.id}` : `option-editor:new:${sectionId}`
  // Edit mode always seeds from the option record -- draft persistence is
  // disabled so a stale autosave can never leak in (Form & Flow Standard
  // §5.2). Create mode (including paste-a-link prefill) keeps draft
  // persistence.
  const { values, setValues, updateField, clearDraft } = useFormDraft<OptionFormValues>(draftKey, EMPTY_VALUES, {
    enabled: !isEditing,
  })

  useEffect(() => {
    if (isOpen) {
      if (option) {
        setValues(fromOption(option))
      } else if (prefillDraft) {
        setValues(fromDraft(prefillDraft))
      } else {
        setValues(EMPTY_VALUES)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, option?.id])

  const seed = option ? fromOption(option) : prefillDraft ? fromDraft(prefillDraft) : EMPTY_VALUES
  const isDirty = JSON.stringify(values) !== JSON.stringify(seed)
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isDirty)
  const handleClose = () => confirmClose(onClose)

  const isPending = createOption.isPending || updateOption.isPending || deleteOption.isPending

  const handleSave = async () => {
    if (!values.title.trim()) {
      showToast({ type: 'error', message: 'Please enter a title' })
      return
    }

    const metadata =
      values.gridRow.trim() && values.gridColumn.trim()
        ? { grid_row: values.gridRow.trim(), grid_column: values.gridColumn.trim() }
        : null

    try {
      if (isEditing) {
        await updateOption.mutateAsync({
          id: option!.id,
          update: {
            title: values.title.trim(),
            description: values.description.trim() || null,
            price: values.price ? parseFloat(values.price) : null,
            currency: values.price ? values.currency : null,
            price_type: values.priceType,
            metadata,
          },
        })
        showToast({ type: 'success', message: 'Option updated' })
      } else {
        const created = await createOption.mutateAsync({
          section_id: sectionId,
          title: values.title.trim(),
          description: values.description.trim() || null,
          price: values.price ? parseFloat(values.price) : null,
          currency: values.price ? values.currency : null,
          price_type: values.priceType,
          metadata,
        })
        logActivity({ verb: 'option_added', entity: { type: 'option', id: created.id, label: values.title.trim() } })
        showToast({ type: 'success', message: 'Option added' })
      }
      clearDraft()
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not save option', description: (err as Error).message })
    }
  }

  const handleDelete = async () => {
    if (!option) return
    try {
      await deleteOption.mutateAsync(option.id)
      showToast({ type: 'success', message: 'Option deleted' })
      clearDraft()
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not delete option', description: (err as Error).message })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="md" title={isEditing ? 'Edit option' : 'Add option'}>
      <div className="space-y-4">
        <Input label="Title" value={values.title} onChange={(e) => updateField('title', e.target.value)} required autoFocus />
        <TextArea
          label="Description (optional)"
          value={values.description}
          onChange={(e) => updateField('description', e.target.value)}
          rows={3}
        />

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Price (optional)"
            type="number"
            value={values.price}
            onChange={(e) => updateField('price', e.target.value)}
            placeholder="0.00"
          />
          <Select
            label="Currency"
            value={values.currency}
            onChange={(e) => updateField('currency', e.target.value)}
            options={['GBP', 'EUR', 'USD', 'JPY', 'CHF', 'AUD', 'CAD'].map((c) => ({ value: c, label: c }))}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-[var(--text-primary)] mb-2">How is the price applied?</label>
          <SegmentedControl
            fullWidth
            value={values.priceType}
            onChange={(v) => updateField('priceType', v)}
            options={PRICE_TYPE_OPTIONS}
            size="sm"
          />
        </div>

        {values.priceType === 'per_person_tiered' && (
          <div className="grid grid-cols-2 gap-3 p-3 bg-[var(--surface-sunken)] rounded-[var(--radius-md)]">
            <Input
              label="Matrix row"
              value={values.gridRow}
              onChange={(e) => updateField('gridRow', e.target.value)}
              placeholder="e.g. Level A"
              helperText="Options sharing a row/column pair form a matrix"
            />
            <Input
              label="Matrix column"
              value={values.gridColumn}
              onChange={(e) => updateField('gridColumn', e.target.value)}
              placeholder="e.g. Skis+Boots"
            />
          </div>
        )}

        <div className="flex justify-between items-center pt-4 border-t border-[var(--border-subtle)]">
          <div>
            {isEditing && (
              <Button variant="danger" size="sm" onClick={handleDelete} isLoading={deleteOption.isPending}>
                Delete
              </Button>
            )}
          </div>
          <div className="flex gap-3">
            <Button variant="outline" onClick={handleClose} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={handleSave} isLoading={createOption.isPending || updateOption.isPending}>
              {isEditing ? 'Save changes' : 'Add option'}
            </Button>
          </div>
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
