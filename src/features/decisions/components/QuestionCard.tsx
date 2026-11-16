import { useId, useState, type ReactNode } from 'react'
import { Badge, Button, PriceTag } from '../../../components/ui'
import type { OptionWithSelections, SectionWithOptions } from '../../../lib/queries/usePlanning'
import type { Trip } from '../../../types'
import { useParticipants } from '../../../lib/queries/useTrip'
import { useQuestionPasses, useVotes } from '../../../lib/queries/usePlanning'
import { AnswerControl } from './AnswerControl'
import { EveryonesAnswers } from './EveryonesAnswers'
import { useOptionPrice } from '../lib/useOptionPrice'
import { useQuestionAnswers } from '../lib/useQuestionAnswers'
import { CHANGE_ANY_TIME, NO_OPTIONS_NOTE, NO_OPTIONS_ORGANIZER_NOTE } from '../lib/answerCopy'
import type { CardChip, StripStep } from '../lib/questionCardModel'

export interface QuestionCardProps {
  trip: Trip
  /** The question with nested options and selections (`useSections` row). */
  section: SectionWithOptions
  /**
   * Organisers only. When present the card shows ONE "⋯ Manage" button that
   * calls this (the Manage sheet is slice 2D). Nothing else organiser-only
   * renders inside the card.
   */
  onManage?: () => void
  /**
   * Price slot: rendered under each option row and under the decided option.
   * Defaults to the one price display (computeOptionPrice + PriceTag).
   */
  renderPrice?: (option: OptionWithSelections, section: SectionWithOptions) => ReactNode
  /** Override the starting state of the answer area (default: open only while this person still owes an answer). */
  defaultExpanded?: boolean
  /** Option ids with a live booking (Booked state). Legacy `option.status === 'booked'` is read from the options. */
  bookedOptionIds?: ReadonlySet<string>
  /** Booked state detail line, e.g. "🧾 Booked · £1,989.60 paid by Chloe · ref HMX42". */
  bookedSummary?: ReactNode
  /** Decided state sub-line for participants: "Tim is booking this". */
  bookingNote?: ReactNode
  /** Extra content under the card body (Phase 4: "Mark booked" and the like belong in Manage, not here). */
  footer?: ReactNode
  /** Option to emphasise and scroll to inside the answer control (the item sheet passes the tapped option). */
  focusOptionId?: string | null
  className?: string
}

const TONE_TO_BADGE: Record<CardChip['tone'], 'warning' | 'success' | 'info' | 'neutral'> = {
  warning: 'warning',
  success: 'success',
  info: 'info',
  neutral: 'neutral',
}

/** Read-only "who chose what" for ordinary participants of an Own choice question (only mounted while results are visible). */
function ParticipantChoices({ trip, section }: { trip: Trip; section: SectionWithOptions }) {
  const { data: participants } = useParticipants(trip.id)
  const { data: votes } = useVotes(trip.id)
  const { passes } = useQuestionPasses(trip.id)
  return (
    <EveryonesAnswers
      participantView
      section={section}
      participants={participants ?? []}
      votes={votes ?? []}
      passes={passes}
      fallbackCurrency={trip.base_currency || 'GBP'}
    />
  )
}

function LifecycleStrip({ steps }: { steps: StripStep[] }) {
  return (
    <ol aria-label="Progress" className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
      {steps.map((step, i) => (
        <li key={step.key} aria-current={step.state === 'current' ? 'step' : undefined} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden="true" className={`h-px w-5 ${step.state === 'todo' ? 'bg-[var(--border-default)]' : 'bg-accent-500'}`} />}
          <span aria-hidden="true" className={step.state === 'todo' ? 'text-[var(--text-muted)]' : 'text-accent-600'}>
            {step.state === 'todo' ? '○' : '●'}
          </span>
          <span className={step.state === 'current' ? 'font-semibold text-[var(--text-primary)]' : step.state === 'todo' ? 'text-[var(--text-muted)]' : ''}>{step.label}</span>
          <span className="sr-only">{step.state === 'done' ? ' (done)' : step.state === 'current' ? ' (current)' : ' (to do)'}</span>
        </li>
      ))}
    </ol>
  )
}

/**
 * One card per question, four states (proposal 5.3):
 *   Open, needs your answer · Open, answered · Decided · Booked
 * plus the muted "Closed — no decision recorded" for an undecided question on
 * a Finished trip. Always shows the Open → Decided → Booked strip, the chip
 * from the answers engine, "N of M answered" and the deadline.
 *
 * The answer area is the shared AnswerControl, expanded while this person
 * still owes an answer and collapsed to a one-line summary once they have
 * answered ("Change" re-opens it). Organiser actions sit behind `onManage`.
 */
export function QuestionCard({ trip, section, onManage, renderPrice, defaultExpanded, bookedOptionIds, bookedSummary, bookingNote, footer, focusOptionId = null, className = '' }: QuestionCardProps) {
  const titleId = useId()
  const bodyId = useId()
  const { card, control, headcount } = useQuestionAnswers(trip, section, { bookedOptionIds })
  const [expanded, setExpanded] = useState(defaultExpanded ?? card.defaultExpanded)
  const [showAll, setShowAll] = useState(false)
  const [showChoices, setShowChoices] = useState(false)

  const priceOf = useOptionPrice(trip, section, headcount, card.stage === 'decided' || card.stage === 'booked')
  const decidedOption = card.decided ? section.options.find((o) => o.id === card.decided!.optionId) : undefined
  const decidedPrice = (() => {
    if (!decidedOption) return null
    if (renderPrice) return renderPrice(decidedOption, section)
    const p = priceOf(decidedOption)
    return p ? <PriceTag price={p} className="w-full pl-7" /> : null
  })()

  return (
    <article
      aria-labelledby={titleId}
      className={`space-y-3 rounded-[var(--radius-xl)] border border-[var(--border-default)] bg-[var(--surface-raised)] p-4 ${card.muted ? 'opacity-75' : ''} ${className}`}
    >
      <header className="space-y-1">
        <div className="flex items-start justify-between gap-2">
          <h3 id={titleId} className="min-w-0 break-words text-base font-semibold text-[var(--text-primary)]">
            {card.title}
          </h3>
          <div className="flex shrink-0 items-center gap-1.5">
            {card.chip && (
              <Badge variant={TONE_TO_BADGE[card.chip.tone]} size="sm">
                {card.chip.label}
              </Badge>
            )}
            {onManage && (
              <Button variant="ghost" size="sm" onClick={onManage} aria-label={`Manage question: ${card.title}`}>
                <span aria-hidden="true">⋯ </span>Manage
              </Button>
            )}
          </div>
        </div>
        <p className={`text-xs ${card.deadline?.passed ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]'}`}>{card.subtitle}</p>
        {card.closedNote && <p className="text-sm text-[var(--text-secondary)]">{card.closedNote}</p>}
      </header>

      {card.strip && <LifecycleStrip steps={card.strip} />}

      <div id={bodyId} className="space-y-3">
        {card.stage === 'open' && (
          <>
            {expanded ? (
              <AnswerControl
                trip={trip}
                section={section}
                renderPrice={renderPrice}
                hideInstruction
                focusOptionId={focusOptionId}
                onAnswered={(plan) => {
                  // A pick-one answer is complete: tuck the options away.
                  if (control.mode === 'single' && plan.addedOptionId) setExpanded(false)
                }}
              />
            ) : (
              <div className="space-y-1">
                {control.mySummary && <p className="text-sm font-medium text-[var(--text-primary)]">{control.mySummary}</p>}
                {control.results.leaderLabel && <p className="text-xs text-[var(--text-secondary)]">{control.results.leaderLabel}</p>}
                {control.results.hiddenNote && <p className="text-xs text-[var(--text-muted)]">{control.results.hiddenNote}</p>}
                <p className="text-xs text-[var(--text-muted)]">
                  {card.viewerState === 'no_options' ? (onManage ? NO_OPTIONS_ORGANIZER_NOTE : NO_OPTIONS_NOTE) : CHANGE_ANY_TIME}
                </p>
              </div>
            )}
            {card.viewerState !== 'not_applicable' && card.viewerState !== 'no_options' && (
              <Button variant="outline" size="sm" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded((v) => !v)}>
                {expanded ? 'Done' : control.mode === 'own' ? 'Change' : 'Change my answer'}
              </Button>
            )}
          </>
        )}

        {(card.stage === 'decided' || card.stage === 'booked') && (
          <>
            {card.decided ? (
              <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] p-3">
                <span aria-hidden="true">✅</span>
                <span className="min-w-0 break-words font-medium text-[var(--text-primary)]">{card.decided.title}</span>
                {decidedPrice}
              </div>
            ) : (
              card.ownClosedLabel && <p className="text-sm font-medium text-[var(--text-primary)]">{card.ownClosedLabel}</p>
            )}
            {card.stage === 'booked' && bookedSummary && <div className="text-sm text-[var(--text-secondary)]">{bookedSummary}</div>}
            {card.stage === 'decided' && bookingNote && <p className="text-sm text-[var(--text-secondary)]">{bookingNote}</p>}
            {control.mySummary && <p className="text-xs text-[var(--text-muted)]">{control.mySummary}</p>}
            <Button variant="ghost" size="sm" aria-expanded={showAll} aria-controls={bodyId} onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Hide options and answers ▴' : 'See all options and answers ▾'}
            </Button>
            {showAll && <AnswerControl trip={trip} section={section} closed renderPrice={renderPrice} hideInstruction focusOptionId={focusOptionId} />}
          </>
        )}

        {/* Own choice: everyone can see what everyone chose in every state, including closed and finished. */}
        {control.mode === 'own' && control.results.visible && card.viewerState !== 'no_options' && (
          <>
            <Button variant="ghost" size="sm" aria-expanded={showChoices} onClick={() => setShowChoices((v) => !v)}>
              {showChoices ? 'Hide what everyone chose ▴' : 'See what everyone chose ▾'}
            </Button>
            {showChoices && <ParticipantChoices trip={trip} section={section} />}
          </>
        )}
      </div>

      {footer}
    </article>
  )
}
