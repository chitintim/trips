import { Button } from '../../../components/ui'
import type { CompanionSuggestion } from '../lib/companions'

export interface CompanionSuggestionCardProps {
  suggestion: CompanionSuggestion
  onAccept: (suggestion: CompanionSuggestion) => void
  onDismiss: (suggestion: CompanionSuggestion) => void
}

const KIND_EMOJI: Record<CompanionSuggestion['kind'], string> = {
  suggest_transfer: '🚐',
  suggest_checkin: '🏨',
  suggest_checkout: '🧳',
}

/**
 * Companion suggestion card (UX_REDESIGN.md Part 3 "Ambient AI" #3): a
 * dismissible, rule-derived nudge distinct from DerivedMilestoneRow — this
 * is an opinion ("you might want this"), not a fact about the trip's
 * dates, so it gets a distinct dismissible-card treatment rather than the
 * muted system-row style. Accept opens EventEditorSheet prefilled;
 * dismiss persists to localStorage per trip+key (see companions.ts).
 */
export function CompanionSuggestionCard({ suggestion, onAccept, onDismiss }: CompanionSuggestionCardProps) {
  return (
    <div className="flex items-start gap-3 rounded-[var(--radius-md)] border border-dashed border-accent-300 bg-accent-50/50 dark:bg-accent-950/20 px-3 py-2.5">
      <span aria-hidden="true" className="text-lg">
        {KIND_EMOJI[suggestion.kind]}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[var(--text-primary)]">{suggestion.title}</p>
        <p className="text-xs text-[var(--text-secondary)] mt-0.5">{suggestion.description}</p>
        <div className="mt-2 flex gap-2">
          <Button size="sm" onClick={() => onAccept(suggestion)}>
            Add it
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onDismiss(suggestion)}>
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  )
}
