import { useMemo, useState } from 'react'
import { EmptyState } from '../../../components/ui'
import { NothingToDecide } from '../../../components/ui/illustrations'
import { useAuth } from '../../../hooks/useAuth'
import { useSections, useVotes } from '../../../lib/queries/usePlanning'
import { useParticipants } from '../../../lib/queries/useTrip'
import { computeQuestionState, formatEntryCardLabel } from '../lib/responseState'
import { AnswerFlow } from './AnswerFlow'
import type { Trip } from '../../../types'

export interface PlanDecideLensProps {
  trip: Trip
}

/**
 * Decide lens (UX_REDESIGN.md Part 5 "Focused answer flow"): a single entry
 * card — "N things need you · ~X min" — rather than a scrolling wall of
 * every open question. Tapping it launches the AnswerFlow stepper, one
 * question per screen (vote UI for group-vote questions, the order form
 * inline for personal-picks questions).
 */
export function PlanDecideLens({ trip }: PlanDecideLensProps) {
  const { user } = useAuth()
  const { data: sections } = useSections(trip.id)
  const { data: votes } = useVotes(trip.id)
  const { data: participants } = useParticipants(trip.id)
  const [flowOpen, setFlowOpen] = useState(false)

  const confirmedCount = (participants || []).filter((p) => p.confirmation_status === 'confirmed').length

  const openQuestions = useMemo(() => {
    return (sections || [])
      .filter((s) => s.status !== 'completed' && s.options.some((o) => o.status !== 'cancelled'))
      .filter(
        (s) => computeQuestionState(s, votes || [], (participants || []).length, user?.id ?? null, trip.base_currency).state === 'needs_you'
      )
  }, [sections, votes, participants, user?.id, trip.base_currency])

  if (openQuestions.length === 0) {
    return (
      <EmptyState
        icon={<NothingToDecide className="w-32 h-24 text-[var(--text-muted)]" />}
        title="Nothing needs deciding"
        description="Every open question has been answered or closed. Nice work."
      />
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setFlowOpen(true)}
        className="w-full text-left rounded-[var(--radius-xl)] border border-accent-300 bg-accent-50 dark:bg-accent-950/30 p-5 hover:border-accent-400 transition-colors"
      >
        <p className="text-lg font-semibold text-[var(--text-primary)]">{formatEntryCardLabel(openQuestions.length)}</p>
        <span className="inline-block mt-3 text-sm font-medium text-accent-700 dark:text-accent-400">Start →</span>
      </button>

      <AnswerFlow
        isOpen={flowOpen}
        onClose={() => setFlowOpen(false)}
        trip={trip}
        sections={openQuestions}
        votes={votes || []}
        participants={participants || []}
        confirmedCount={confirmedCount}
      />
    </>
  )
}
