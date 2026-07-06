import { Input, Select } from '../../../components/ui'
import { AmountCurrencyInput } from '../components/AmountCurrencyInput'
import { ParticipantChipRow } from '../components/ParticipantChipRow'
import { ALL_CATEGORIES, categoryIcon, categoryLabel } from '../lib/categoryStyle'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { ExpenseWizardDraft } from './wizardState'

export interface DetailsStepProps {
  draft: ExpenseWizardDraft
  onChange: (patch: Partial<ExpenseWizardDraft>) => void
  participants: ParticipantWithUser[]
}

/**
 * Details step (plan §10 #2): amount/currency, date, category, vendor,
 * "WHO WAS THERE?" participant chip row (writes expenses.participant_ids).
 * Place linking deferred to Workstream F (places/maps) -- not built here.
 */
export function DetailsStep({ draft, onChange, participants }: DetailsStepProps) {
  const toggleParticipant = (userId: string) => {
    const isSelected = draft.participantIds.includes(userId)
    onChange({
      participantIds: isSelected
        ? draft.participantIds.filter((id) => id !== userId)
        : [...draft.participantIds, userId],
    })
  }

  return (
    <div className="space-y-5">
      <Input
        label="What was it for?"
        placeholder="e.g. Dinner at the izakaya"
        value={draft.description}
        onChange={(e) => onChange({ description: e.target.value })}
        required
      />

      <AmountCurrencyInput
        amount={draft.amount}
        onAmountChange={(v) => onChange({ amount: v })}
        currency={draft.currency}
        onCurrencyChange={(v) => onChange({ currency: v })}
      />

      <div className="grid grid-cols-2 gap-3">
        <Input
          type="date"
          label="Date"
          value={draft.paymentDate}
          onChange={(e) => onChange({ paymentDate: e.target.value })}
        />
        <Select
          label="Category"
          value={draft.category}
          onChange={(e) => onChange({ category: e.target.value })}
          options={ALL_CATEGORIES.map((c) => ({ value: c, label: `${categoryIcon(c)} ${categoryLabel(c)}` }))}
        />
      </div>

      <Input
        label="Vendor (optional)"
        placeholder="e.g. Ichiran Ramen"
        value={draft.vendorName}
        onChange={(e) => onChange({ vendorName: e.target.value })}
      />

      <div>
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">Who was there?</label>
        <ParticipantChipRow
          participants={participants}
          selectedUserIds={draft.participantIds}
          onToggle={toggleParticipant}
        />
      </div>
    </div>
  )
}
