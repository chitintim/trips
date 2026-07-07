import { useState } from 'react'
import { Modal, Button, Badge, Stepper } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useToggleVote } from '../../../lib/queries/usePlanning'
import { formatCostImpact, getTierSensitivityLine } from '../../decisions/lib/costImpact'
import type { VotingMethod } from '../../decisions/lib/voting'
import { useOrderForm } from '../lib/useOrderForm'
import { OrderFormFields } from './OrderFormFields'
import type { SectionWithOptions, OptionVote } from '../../../lib/queries/usePlanning'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { Trip } from '../../../types'

export interface AnswerFlowProps {
  isOpen: boolean
  onClose: () => void
  trip: Trip
  /** Open questions (already filtered/sorted by the caller — PlanDecideLens), one screen each. */
  sections: SectionWithOptions[]
  votes: OptionVote[]
  participants: ParticipantWithUser[]
  confirmedCount: number
}

/**
 * The focused answer flow (UX_REDESIGN.md Part 5, "glanceability fix"):
 * one question per full-screen step — vote UI for a group-vote question,
 * the personal order form inline for a personal-picks question — with
 * Skip/Next, progress dots, and a completion screen. Replaces scrolling a
 * wall of every open question at once.
 */
export function AnswerFlow({ isOpen, onClose, trip, sections, votes, participants, confirmedCount }: AnswerFlowProps) {
  const [index, setIndex] = useState(0)
  const [done, setDone] = useState(false)

  const total = sections.length
  const current = sections[index]

  const reset = () => {
    setIndex(0)
    setDone(false)
  }

  const handleClose = () => {
    reset()
    onClose()
  }

  const goNext = () => {
    if (index >= total - 1) {
      setDone(true)
    } else {
      setIndex((i) => i + 1)
    }
  }

  const steps = sections.map((s) => ({ key: s.id, label: s.title }))

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="lg" title="Your turn">
      {done || total === 0 ? (
        <div className="py-10 text-center space-y-3">
          <p className="text-4xl">🎉</p>
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">You're all caught up</h3>
          <p className="text-sm text-[var(--text-secondary)]">Nothing else needs you right now.</p>
          <Button onClick={handleClose}>Done</Button>
        </div>
      ) : (
        <div className="space-y-5">
          <Stepper steps={steps} current={index} size="sm" />

          {current && (
            <QuestionStep
              key={current.id}
              trip={trip}
              section={current}
              votes={votes}
              participants={participants}
              confirmedCount={confirmedCount}
              onSkip={goNext}
              onNext={goNext}
              isLast={index === total - 1}
            />
          )}
        </div>
      )}
    </Modal>
  )
}

interface QuestionStepProps {
  trip: Trip
  section: SectionWithOptions
  votes: OptionVote[]
  participants: ParticipantWithUser[]
  confirmedCount: number
  onSkip: () => void
  onNext: () => void
  isLast: boolean
}

function QuestionStep({ trip, section, votes, participants, confirmedCount, onSkip, onNext, isLast }: QuestionStepProps) {
  const isPersonalOrder = (() => {
    const m = section.metadata
    return !!m && typeof m === 'object' && !Array.isArray(m) && (m as Record<string, unknown>).decision_shape === 'personal'
  })()

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-[var(--text-primary)]">{section.title}</h3>
        {section.description && <p className="text-sm text-[var(--text-secondary)] mt-0.5">{section.description}</p>}
      </div>

      {isPersonalOrder ? (
        <PersonalOrderStep trip={trip} section={section} participants={participants} onSkip={onSkip} onNext={onNext} isLast={isLast} />
      ) : (
        <VoteStep section={section} votes={votes} confirmedCount={confirmedCount} onSkip={onSkip} onNext={onNext} isLast={isLast} />
      )}
    </div>
  )
}

function PersonalOrderStep({
  trip,
  section,
  participants,
  onSkip,
  onNext,
  isLast,
}: {
  trip: Trip
  section: SectionWithOptions
  participants: ParticipantWithUser[]
  onSkip: () => void
  onNext: () => void
  isLast: boolean
}) {
  const form = useOrderForm(trip, section)

  const handleSaveAndNext = async () => {
    const ok = await form.save()
    if (ok) onNext()
  }

  return (
    <div className="space-y-4">
      <OrderFormFields section={section} participants={participants} form={form} />
      <div className="flex justify-between gap-3 pt-2 border-t border-[var(--border-subtle)]">
        <Button variant="ghost" onClick={onSkip}>
          Skip for now
        </Button>
        <Button onClick={handleSaveAndNext} isLoading={form.isSaving}>
          {isLast ? 'Save & finish' : 'Save & next'}
        </Button>
      </div>
    </div>
  )
}

function VoteStep({
  section,
  votes,
  confirmedCount,
  onSkip,
  onNext,
  isLast,
}: {
  section: SectionWithOptions
  votes: OptionVote[]
  confirmedCount: number
  onSkip: () => void
  onNext: () => void
  isLast: boolean
}) {
  const { user } = useAuth()
  const toggleVote = useToggleVote(section.trip_id)
  const [votingOptionId, setVotingOptionId] = useState<string | null>(null)

  const votingMethod = (section.voting_method as VotingMethod) || 'single'
  const optionIds = section.options.map((o) => o.id)
  const sectionVotes = votes.filter((v) => optionIds.includes(v.option_id))

  const handleVote = (optionId: string) => {
    if (!user) return
    const myVote = sectionVotes.find((v) => v.option_id === optionId && v.user_id === user.id)
    setVotingOptionId(optionId)
    if (myVote) {
      toggleVote.mutate({ optionId, userId: user.id, action: 'remove', voteId: myVote.id }, { onSettled: () => setVotingOptionId(null) })
    } else {
      toggleVote.mutate({ optionId, userId: user.id, action: 'add' }, { onSettled: () => setVotingOptionId(null) })
    }
  }

  const hasVoted = sectionVotes.some((v) => v.user_id === user?.id)

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {section.options
          .filter((o) => o.status !== 'cancelled')
          .map((option) => {
            const myVote = sectionVotes.find((v) => v.option_id === option.id && v.user_id === user?.id)
            const costImpactInput = { price: option.price, currency: option.currency, priceType: option.price_type, confirmedCount, metadata: option.metadata }
            const costImpact = formatCostImpact(costImpactInput)
            const sensitivityLine = getTierSensitivityLine(costImpactInput)
            return (
              <div key={option.id} className="rounded-[var(--radius-lg)] border border-[var(--border-default)] p-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-[var(--text-primary)]">{option.title}</p>
                  {option.description && <p className="text-xs text-[var(--text-secondary)] mt-0.5">{option.description}</p>}
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    {costImpact && (
                      <Badge variant="info" size="sm">
                        {costImpact}
                      </Badge>
                    )}
                  </div>
                  {sensitivityLine && <p className="mt-1 text-xs text-[var(--text-muted)]">{sensitivityLine}</p>}
                </div>
                <Button
                  variant={myVote ? 'primary' : 'outline'}
                  size="sm"
                  onClick={() => handleVote(option.id)}
                  disabled={option.locked}
                  isLoading={votingOptionId === option.id}
                  className="shrink-0"
                >
                  {myVote ? '✓ Voted' : votingMethod === 'approval' ? 'Approve' : 'Vote'}
                </Button>
              </div>
            )
          })}
      </div>

      <div className="flex justify-between gap-3 pt-2 border-t border-[var(--border-subtle)]">
        <Button variant="ghost" onClick={onSkip}>
          Skip for now
        </Button>
        <Button onClick={onNext} disabled={!hasVoted} title={hasVoted ? undefined : 'Cast a vote to continue, or skip'}>
          {isLast ? 'Finish' : 'Next'}
        </Button>
      </div>
    </div>
  )
}
