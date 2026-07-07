import { Card, UserAvatar } from '../../../components/ui'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { ExpenseWizardDraft } from './wizardState'

export interface PayerStepProps {
  draft: ExpenseWizardDraft
  onChange: (patch: Partial<ExpenseWizardDraft>) => void
  participants: ParticipantWithUser[]
}

/** Payer step (plan §10 #2): single payer selection, smart default = you. */
export function PayerStep({ draft, onChange, participants }: PayerStepProps) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-[var(--text-secondary)] mb-3">Who paid for this?</p>
      {participants.map((p) => {
        const isSelected = draft.paidBy === p.user_id
        return (
          <Card
            key={p.user_id}
            variant={isSelected ? 'default' : 'sunken'}
            clickable
            noPadding
            onClick={() => onChange({ paidBy: p.user_id })}
            className={`flex items-center gap-3 p-3 transition-colors ${
              isSelected ? 'ring-2 ring-accent-500 border-accent-500' : ''
            }`}
          >
            <UserAvatar avatarData={p.user} size="sm" alt={p.user.full_name ?? p.user.email} />
            <span className="flex-1 font-medium text-[var(--text-primary)]">
              {p.user.full_name || p.user.email}
            </span>
            {isSelected && (
              <svg className="w-5 h-5 text-accent-600" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            )}
          </Card>
        )
      })}
    </div>
  )
}
