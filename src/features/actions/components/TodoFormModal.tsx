import { useMemo } from 'react'
import { Button, Input, Modal, Select, TextArea } from '../../../components/ui'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import { ADD_TODO_LABEL, NEW_TODO_LABEL, WHO_ANYONE, WHO_EVERYONE } from '../lib/todoLabels'
import { applyWhoSelect, personSelectValue, whoSelectValue } from '../lib/todoModel'
import type { TodoFormValues, TodoSource } from '../lib/todoModel'

export interface TodoFormModalProps {
  isOpen: boolean
  onClose: () => void
  /** null = creating. Otherwise the source of the row being edited (fixes the kind). */
  editingSource: TodoSource | null
  values: TodoFormValues
  updateField: <K extends keyof TodoFormValues>(key: K, value: TodoFormValues[K]) => void
  setValues: (values: TodoFormValues) => void
  participants: ParticipantWithUser[]
  /** Questions a to-do can be linked to (open ones, plus the one it is already linked to). */
  sections: { id: string; title: string }[]
  /** The who_mode migration is applied: Anyone for general to-dos and an optional due date. */
  whoSupported: boolean
  isPending: boolean
  onSubmit: () => void
}

/**
 * Create / edit a to-do. Up front: title, Who, due date, linked question. The rest
 * (notes, "due before the trip", "something to bring") sits behind "More options".
 * The kind (to-do vs something to bring) is fixed when editing: it decides the table.
 */
export function TodoFormModal({ isOpen, onClose, editingSource, values, updateField, setValues, participants, sections, whoSupported, isPending, onSubmit }: TodoFormModalProps) {
  const editing = editingSource !== null
  const bring = editing ? editingSource === 'checklist' : values.bring
  const allowAnyone = bring || whoSupported
  const allowEveryone = !bring

  const whoOptions = useMemo(
    () => [
      ...(allowEveryone ? [{ value: 'everyone', label: WHO_EVERYONE }] : []),
      ...(allowAnyone ? [{ value: 'anyone', label: WHO_ANYONE }] : []),
      ...participants
        .filter((p) => p.active !== false)
        .map((p) => ({ value: personSelectValue(p.user_id), label: p.user?.full_name || p.user?.email || 'Unknown' })),
    ],
    [participants, allowAnyone, allowEveryone]
  )

  const sectionOptions = useMemo(() => [{ value: '', label: 'None' }, ...sections.map((s) => ({ value: s.id, label: s.title }))], [sections])

  const setBring = (next: boolean) => {
    updateField('bring', next)
    // Something to bring cannot be Everyone (the bring list has one tick per item), and has no due date or question.
    if (next && values.mode === 'everyone') setValues({ ...values, bring: true, mode: 'anyone', personId: '', sectionId: '' })
  }

  const hasDeadline = values.beforeTrip || !!values.dueDate

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" title={editing ? 'Edit to-do' : NEW_TODO_LABEL}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit()
        }}
      >
        <Input
          label="Title"
          value={values.title}
          onChange={(e) => updateField('title', e.target.value)}
          placeholder={bring ? 'e.g. Bluetooth speaker' : 'e.g. Book the villa'}
          required
          autoFocus
        />
        <Select
          label="Who"
          value={whoSelectValue(values)}
          onChange={(e) => setValues({ ...values, ...applyWhoSelect(e.target.value) })}
          options={whoOptions}
          helperText={
            values.mode === 'everyone'
              ? 'Each person ticks it off for themselves.'
              : values.mode === 'anyone'
                ? 'The first person to say "I\'ll do it" owns it, and it moves to their list.'
                : 'Only they (or an organizer) can tick it off.'
          }
        />
        {!bring && (
          <>
            {!values.beforeTrip && (
              <Input
                label={whoSupported ? 'Due date (optional)' : 'Due date'}
                type="date"
                value={values.dueDate}
                onChange={(e) => updateField('dueDate', e.target.value)}
              />
            )}
            <Select
              label="Linked question (optional)"
              value={values.sectionId}
              onChange={(e) => updateField('sectionId', e.target.value)}
              options={sectionOptions}
              helperText="Ticks off when the person answers, or when the question closes."
            />
          </>
        )}

        <details className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-[var(--text-secondary)]">More options</summary>
          <div className="mt-3 space-y-3">
            {!bring && <TextArea label="Notes" value={values.notes} onChange={(e) => updateField('notes', e.target.value)} rows={2} />}
            {!bring && (
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={values.beforeTrip}
                  onChange={(e) => updateField('beforeTrip', e.target.checked)}
                  className="h-5 w-5 accent-accent-600"
                />
                <span className="text-sm text-[var(--text-primary)]">Due before the trip starts</span>
              </label>
            )}
            {!editing && (
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={values.bring} onChange={(e) => setBring(e.target.checked)} className="h-5 w-5 accent-accent-600" />
                <span className="text-sm text-[var(--text-primary)]">It's something to bring</span>
              </label>
            )}
          </div>
        </details>

        {!bring && hasDeadline && (
          <p className="text-xs text-[var(--text-muted)]">
            With a due date, reminder emails go to whoever it is for: 7 days before, 1 day before, and once overdue. The organizer can turn this off for the whole trip in
            Auto-chase settings.
          </p>
        )}

        <div className="flex justify-end gap-3 border-t border-[var(--border-subtle)] pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" isLoading={isPending}>
            {editing ? 'Save' : ADD_TODO_LABEL}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
