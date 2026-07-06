import { useMemo, useState } from 'react'
import { Modal, Button, Input, TextArea, Select, useToast } from '../../../components/ui'
import { useSections } from '../../../lib/queries/usePlanning'
import { ProposedActionSchema, type ProposedAction } from '../../../shared/contracts/aiProposal'

export interface ProposalActionEditSheetProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  /** The action being edited; invalid raw actions arrive as a partial record. */
  action: ProposedAction | Record<string, unknown>
  /** Called with the edited, re-validated action. */
  onSave: (action: ProposedAction) => void
}

/**
 * Light per-field editor for a proposed action before approving it (plan
 * §13.2 "per-card Approve / Edit / Discard"). Values are re-validated
 * against the ProposedAction contract on save — an edit can fix an invalid
 * action (e.g. pick the missing poll section for create_option) but can
 * never smuggle in an invalid one.
 */
export function ProposalActionEditSheet({ isOpen, onClose, tripId, action, onSave }: ProposalActionEditSheetProps) {
  const { showToast } = useToast()
  const { data: sections } = useSections(tripId)
  const type = (action as { type?: string }).type ?? ''

  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {}
    for (const [key, val] of Object.entries(action)) {
      if (val == null) continue
      if (typeof val === 'string' || typeof val === 'number') v[key] = String(val)
    }
    return v
  })

  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setValues((prev) => ({ ...prev, [key]: e.target.value }))

  const sectionOptions = useMemo(
    () => (sections ?? []).map((s) => ({ value: s.id, label: s.title })),
    [sections]
  )

  const handleSave = () => {
    const merged: Record<string, unknown> = { ...(action as Record<string, unknown>) }
    for (const [key, val] of Object.entries(values)) {
      if (val === '') {
        merged[key] = null
        continue
      }
      merged[key] = ['amount', 'price'].includes(key) ? Number(val) : val
    }
    // Strings for nullable-optional time fields; drop nulls the schema
    // doesn't accept as null.
    for (const key of Object.keys(merged)) {
      if (merged[key] === null && !['start_time', 'end_time', 'location', 'description', 'vendor', 'confirmation_ref', 'reason', 'source_text', 'currency', 'price', 'amount', 'booking_date', 'cancellation_deadline', 'paid_by', 'option_id', 'section_id'].includes(key)) {
        delete merged[key]
      }
    }
    const result = ProposedActionSchema.safeParse(merged)
    if (!result.success) {
      const issue = result.error.issues[0]
      showToast({
        type: 'error',
        message: 'Still not valid',
        description: issue ? `${issue.path.join('.') || 'action'}: ${issue.message}` : undefined,
      })
      return
    }
    onSave(result.data)
    onClose()
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md" title="Edit proposed change">
      <div className="space-y-4">
        {type === 'create_option' && (
          <Select
            label="Poll / section"
            value={values.section_id ?? ''}
            onChange={set('section_id')}
            options={[{ value: '', label: 'Pick a section…', disabled: true }, ...sectionOptions]}
            helperText="Which decision this option belongs to"
          />
        )}

        {'title' in action || ['create_event', 'create_option', 'create_booking_draft', 'update_event'].includes(type) ? (
          <Input label="Title" value={values.title ?? ''} onChange={set('title')} />
        ) : null}

        {type === 'create_expense_draft' && (
          <Input label="Description" value={values.description ?? ''} onChange={set('description')} />
        )}
        {type !== 'create_expense_draft' && ('description' in action || ['create_event', 'create_option', 'update_event'].includes(type)) && (
          <TextArea label="Description" value={values.description ?? ''} onChange={set('description')} rows={2} />
        )}

        {['create_event', 'update_event'].includes(type) && (
          <div className="grid grid-cols-3 gap-3">
            <Input label="Date" type="date" value={values.event_date ?? ''} onChange={set('event_date')} />
            <Input label="Start" type="time" value={values.start_time ?? ''} onChange={set('start_time')} />
            <Input label="End" type="time" value={values.end_time ?? ''} onChange={set('end_time')} />
          </div>
        )}
        {['create_event', 'update_event'].includes(type) && (
          <Input label="Location" value={values.location ?? ''} onChange={set('location')} />
        )}

        {['create_option', 'create_booking_draft', 'create_expense_draft'].includes(type) && (
          <div className="grid grid-cols-2 gap-3">
            <Input
              label={type === 'create_option' ? 'Price' : 'Amount'}
              type="number"
              step="0.01"
              value={values[type === 'create_option' ? 'price' : 'amount'] ?? ''}
              onChange={set(type === 'create_option' ? 'price' : 'amount')}
            />
            <Input
              label="Currency"
              value={values.currency ?? ''}
              onChange={(e) => setValues((prev) => ({ ...prev, currency: e.target.value.toUpperCase().slice(0, 3) }))}
              placeholder="GBP"
            />
          </div>
        )}

        {type === 'create_booking_draft' && (
          <div className="grid grid-cols-2 gap-3">
            <Input label="Vendor" value={values.vendor ?? ''} onChange={set('vendor')} />
            <Input label="Confirmation ref" value={values.confirmation_ref ?? ''} onChange={set('confirmation_ref')} />
          </div>
        )}
        {type === 'create_booking_draft' && (
          <Input label="Booking date" type="date" value={values.booking_date ?? ''} onChange={set('booking_date')} />
        )}

        {type === 'create_expense_draft' && (
          <Input label="Payment date" type="date" value={values.payment_date ?? ''} onChange={set('payment_date')} />
        )}

        <div className="flex justify-end gap-3 pt-2 border-t border-[var(--border-subtle)]">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save changes</Button>
        </div>
      </div>
    </Modal>
  )
}
