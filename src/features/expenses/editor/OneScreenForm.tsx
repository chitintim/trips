import { useState, type ReactNode } from 'react'
import { Input, Button, UserAvatar } from '../../../components/ui'
import { AmountCurrencyInput } from '../components/AmountCurrencyInput'
import { ParticipantChipRow } from '../components/ParticipantChipRow'
import { ALL_CATEGORIES, categoryIcon, categoryLabel } from '../lib/categoryStyle'
import { SplitStep } from './SplitStep'
import { FxCard } from './FxCard'
import { categoryAfterTitle, validateForm, primaryButtonLabel, splitSummary, dateSummary, toggleLine, type OpenLine } from './expenseFormLogic'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { TimelineEvent } from '../../../types'
import type { ExpenseWizardDraft } from './wizardState'

export interface OneScreenFormProps {
  draft: ExpenseWizardDraft
  onChange: (patch: Partial<ExpenseWizardDraft>) => void
  participants: ParticipantWithUser[]
  baseCurrency: string
  today: string
  isEdit: boolean
  isSaving: boolean
  onSubmit: () => void
  onDelete?: () => void
  timelineEvents: TimelineEvent[]
  tripStartDate: string
  tripEndDate: string
  onGoToItemized: () => void
  existingItemizedInfo?: { lineItemCount: number; claimCount: number }
  onItemizedSwitchBlocked?: () => void
  /** Receipt attach row (owned by the wizard: it holds the file). */
  receiptSlot: ReactNode
  /** Banner above the fields (scan: "Itemise · N items read" / "Just split the total"). */
  topSlot?: ReactNode
  /** Possible-duplicate warning text, if any. */
  duplicateNote?: string | null
  currentUserId: string
  /** Set when the total belongs to the items (an itemised receipt being edited): the amount and currency are shown but locked, with this explanation. */
  amountLockedNote?: string
}

/**
 * The one screen for adding or editing an expense. Amount and "What was it for?"
 * are always visible; Paid by, Split and Date are one-line summaries that open in
 * place when tapped. The primary button says what will happen.
 */
export function OneScreenForm(props: OneScreenFormProps) {
  const { draft, onChange, participants, baseCurrency, today, isEdit, isSaving, onSubmit, onDelete, currentUserId } = props
  const [touched, setTouched] = useState({ title: false, amount: false })
  const [open, setOpen] = useState<OpenLine>(null)
  // True once the person picks a category themselves (an existing expense counts as picked). The mealtime default and scan guess do not.
  const [categoryPicked, setCategoryPicked] = useState(isEdit)

  const { errors, canSubmit } = validateForm(draft, touched)
  const payer = participants.find((p) => p.user_id === draft.paidBy)
  const payerName = draft.paidBy === currentUserId ? 'you' : payer?.user.full_name || payer?.user.email || 'someone else'
  const activeParticipants = participants.filter((p) => draft.participantIds.includes(p.user_id))

  const onTitle = (value: string) => {
    onChange({ description: value, category: categoryAfterTitle(value, draft.category, categoryPicked) })
  }

  const toggleParticipant = (userId: string) =>
    onChange({
      participantIds: draft.participantIds.includes(userId) ? draft.participantIds.filter((id) => id !== userId) : [...draft.participantIds, userId],
    })

  const line = (key: Exclude<OpenLine, null>, label: string, value: string, body: ReactNode) => (
    <div className="border-b border-[var(--border-subtle)]">
      <button
        type="button"
        aria-expanded={open === key}
        aria-controls={`expense-line-${key}`}
        onClick={() => setOpen(toggleLine(open, key))}
        className="w-full flex items-center justify-between gap-3 py-3 min-h-12 text-left press-scale"
      >
        <span className="text-sm">
          <span className="text-[var(--text-secondary)]">{label} </span>
          <span className="font-medium text-[var(--text-primary)]">{value}</span>
        </span>
        <span aria-hidden="true" className="text-[var(--text-muted)]">{open === key ? '▴' : '▾'}</span>
      </button>
      {open === key && (
        <div id={`expense-line-${key}`} className="pb-4">
          {body}
        </div>
      )}
    </div>
  )

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault()
        setTouched({ title: true, amount: true })
        if (canSubmit && !isSaving) onSubmit()
      }}
    >
      {props.topSlot}
      {props.duplicateNote && (
        <div className="rounded-[var(--radius-md)] border border-warn-200 bg-warn-50 dark:bg-warn-900 dark:border-warn-800 px-3 py-2.5 text-sm text-warn-700 dark:text-warn-300" role="status">
          {props.duplicateNote}
        </div>
      )}

      <AmountCurrencyInput
        disabled={!!props.amountLockedNote}
        amount={draft.amount}
        onAmountChange={(v) => onChange({ amount: v })}
        currency={draft.currency}
        onCurrencyChange={(v) => onChange({ currency: v })}
        onBlur={() => setTouched((t) => ({ ...t, amount: true }))}
        error={errors.amount}
      />
      {props.amountLockedNote ? (
        <p className="-mt-3 text-xs text-[var(--text-muted)]">{props.amountLockedNote}</p>
      ) : (
        <FxCard draft={draft} onChange={onChange} baseCurrency={baseCurrency} />
      )}

      <Input
        label="What was it for?"
        placeholder="e.g. Dinner at the izakaya"
        value={draft.description}
        onChange={(e) => onTitle(e.target.value)}
        onBlur={() => setTouched((t) => ({ ...t, title: true }))}
        error={errors.title}
        required
      />
      {errors.vendor && (
        <p role="alert" className="-mt-3 text-xs text-danger-600">
          {errors.vendor}
        </p>
      )}

      <div role="group" aria-label="Category" className="flex flex-wrap gap-1.5">
        {ALL_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={draft.category === c}
            onClick={() => {
              setCategoryPicked(true)
              onChange({ category: c })
            }}
            className={`px-2.5 py-1.5 rounded-[var(--radius-full)] text-xs font-medium border transition-colors ${
              draft.category === c ? 'bg-accent-600 border-accent-600 text-white' : 'bg-[var(--surface-sunken)] border-transparent text-[var(--text-secondary)]'
            }`}
          >
            {categoryIcon(c)} {categoryLabel(c)}
          </button>
        ))}
      </div>

      <div className="border-t border-[var(--border-subtle)]">
        {line(
          'payer',
          'Paid by',
          payerName,
          <div role="radiogroup" aria-label="Who paid?" className="flex flex-wrap gap-2">
            {participants.map((p) => (
              <button
                key={p.user_id}
                type="button"
                role="radio"
                aria-checked={draft.paidBy === p.user_id}
                onClick={() => {
                  onChange({ paidBy: p.user_id })
                  setOpen(null)
                }}
                className={`flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-[var(--radius-full)] border text-sm ${
                  draft.paidBy === p.user_id ? 'border-accent-500 ring-2 ring-accent-500' : 'border-[var(--border-default)]'
                }`}
              >
                <UserAvatar avatarData={p.user} size="xs" alt="" />
                {p.user_id === currentUserId ? 'You' : p.user.full_name || p.user.email}
              </button>
            ))}
          </div>
        )}
        {line(
          'split',
          '',
          splitSummary(draft),
          <div className="space-y-4">
            <div>
              <p className="block text-sm font-medium text-[var(--text-secondary)] mb-2">Who is it split between?</p>
              <ParticipantChipRow participants={participants} selectedUserIds={draft.participantIds} onToggle={toggleParticipant} />
              {errors.people && (
                <p className="text-sm text-danger-600 mt-1" role="alert">
                  {errors.people}
                </p>
              )}
            </div>
            <SplitStep
              draft={draft}
              onChange={onChange}
              participants={activeParticipants}
              timelineEvents={props.timelineEvents}
              tripStartDate={props.tripStartDate}
              tripEndDate={props.tripEndDate}
              onGoToItemized={props.onGoToItemized}
              existingItemizedInfo={props.existingItemizedInfo}
              onItemizedSwitchBlocked={props.onItemizedSwitchBlocked}
            />
          </div>
        )}
        {line(
          'date',
          '',
          dateSummary(draft.paymentDate, today),
          <Input type="date" label="Date" value={draft.paymentDate} onChange={(e) => onChange({ paymentDate: e.target.value })} />
        )}
      </div>

      {(errors.split || errors.people) && open !== 'split' && (
        <p className="text-sm text-danger-600" role="alert">
          {errors.split ?? errors.people}{' '}
          <button type="button" className="underline" onClick={() => setOpen('split')}>
            Fix it
          </button>
        </p>
      )}

      <div className="pt-1">{props.receiptSlot}</div>

      <div className="flex items-center gap-3 pt-2">
        {isEdit && onDelete && (
          <Button type="button" variant="danger" onClick={onDelete} disabled={isSaving}>
            Delete
          </Button>
        )}
        <Button type="submit" variant="primary" fullWidth disabled={!canSubmit} isLoading={isSaving}>
          {primaryButtonLabel(draft, isEdit)}
        </Button>
      </div>
    </form>
  )
}
