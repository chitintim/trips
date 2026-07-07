import { useState } from 'react'
import { Card } from '../../../components/ui'
import { isCardDismissed, dismissCard } from '../lib/dismissals'

const CARD_KEY = 'next-steps'

export interface NextStepsCardProps {
  tripId: string
  onInvite: () => void
  onSetBrief: () => void
  onStartAccommodationVote: () => void
}

/**
 * Post-creation NEXT-STEPS card (UX_REDESIGN Part 2 "Trip creation →
 * guided setup"): invite people → set the brief → start the accommodation
 * vote. Dismissal persists in localStorage.
 */
export function NextStepsCard({ tripId, onInvite, onSetBrief, onStartAccommodationVote }: NextStepsCardProps) {
  const [dismissed, setDismissed] = useState(() => isCardDismissed(tripId, CARD_KEY))
  if (dismissed) return null

  const dismiss = () => {
    dismissCard(tripId, CARD_KEY)
    setDismissed(true)
  }

  const steps = [
    { icon: '✉️', label: 'Invite people', onClick: onInvite },
    { icon: '📋', label: 'Set the brief', onClick: onSetBrief },
    { icon: '🏠', label: 'Start the accommodation vote', onClick: onStartAccommodationVote },
  ]

  return (
    <Card variant="flat">
      <Card.Content className="space-y-2 py-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Get the trip rolling</h3>
          <button
            onClick={dismiss}
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            aria-label="Dismiss next steps"
          >
            Dismiss
          </button>
        </div>
        <ol className="space-y-1.5">
          {steps.map((step, i) => (
            <li key={step.label}>
              <button
                onClick={step.onClick}
                className="w-full flex items-center gap-2 text-left text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              >
                <span className="text-xs font-semibold text-[var(--text-muted)] w-4">{i + 1}.</span>
                <span aria-hidden="true">{step.icon}</span>
                <span className="flex-1">{step.label}</span>
                <span aria-hidden="true">→</span>
              </button>
            </li>
          ))}
        </ol>
      </Card.Content>
    </Card>
  )
}

