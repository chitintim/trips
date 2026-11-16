import { useCallback, useEffect, useState } from 'react'
import { Modal, Button, Badge } from '../../../components/ui'
import { AnswerControl, useQuestionAnswers } from '../../decisions'
import { freezeFlowIds, resolveFlowSteps, progressLabel, canAdvance, summariseFlow, type StepRecord } from '../lib/answerFlow'
import type { SectionWithOptions } from '../../../lib/queries/usePlanning'
import type { Trip } from '../../../types'

export interface AnswerFlowProps {
  isOpen: boolean
  onClose: () => void
  trip: Trip
  /**
   * Questions to step through (the caller filters/sorts them: the shell passes
   * the viewer's answer to-dos, the Questions lens its "needs me" list). The list
   * is frozen when the flow opens; each step then reads the live question from
   * this prop by id.
   */
  sections: SectionWithOptions[]
}

/**
 * The step-through "answer all" flow (`?open=answer-all`, `?open=question:<id>`):
 * one question per step using the one shared AnswerControl, with Back, Skip,
 * the pass option (rendered by the control), "2 of 5" progress and a finish
 * screen that says exactly what was and was not answered.
 */
export function AnswerFlow({ isOpen, onClose, trip, sections }: AnswerFlowProps) {
  if (!isOpen) return null
  return <AnswerFlowSession onClose={onClose} trip={trip} sections={sections} />
}

function AnswerFlowSession({ onClose, trip, sections }: Pick<AnswerFlowProps, 'onClose' | 'trip' | 'sections'>) {
  // Frozen at open: answering a question must not shorten the list.
  const [ids] = useState(() => freezeFlowIds(sections))
  const steps = resolveFlowSteps(ids, sections)
  const [index, setIndex] = useState(0)
  const [done, setDone] = useState(false)
  const [records, setRecords] = useState<Record<string, StepRecord>>({})

  const total = steps.length
  const current = steps[Math.min(index, Math.max(total - 1, 0))]

  const record = useCallback((id: string, next: StepRecord) => {
    setRecords((prev) => (prev[id]?.state === next.state && prev[id]?.closed === next.closed ? prev : { ...prev, [id]: next }))
  }, [])

  const goNext = () => {
    if (index >= total - 1) setDone(true)
    else setIndex((i) => i + 1)
  }

  const summary = summariseFlow(
    steps.map((s) => s.id),
    records
  )

  return (
    <Modal isOpen onClose={onClose} size="lg" title="Your answers">
      {done || total === 0 ? (
        <div className="space-y-3 py-8 text-center" role="status">
          <p className="text-4xl" aria-hidden="true">
            {summary.skippedIds.length > 0 ? '👀' : '🎉'}
          </p>
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">{summary.headline}</h3>
          {summary.detail && <p className="text-sm text-[var(--text-secondary)]">{summary.detail}</p>}
          <div className="flex flex-wrap justify-center gap-2 pt-2">
            {summary.skippedIds.length > 0 && (
              <Button
                onClick={() => {
                  setIndex(Math.max(0, steps.findIndex((s) => s.id === summary.skippedIds[0])))
                  setDone(false)
                }}
              >
                Answer {summary.skippedIds.length === 1 ? 'it' : 'them'} now
              </Button>
            )}
            <Button variant={summary.skippedIds.length > 0 ? 'ghost' : 'primary'} onClick={onClose}>
              {summary.skippedIds.length > 0 ? 'Later' : 'Done'}
            </Button>
          </div>
        </div>
      ) : (
        current && (
          <QuestionStep
            key={current.id}
            trip={trip}
            section={current}
            progress={progressLabel(index, total)}
            fraction={(index + 1) / total}
            isFirst={index === 0}
            isLast={index === total - 1}
            onRecord={record}
            onBack={() => setIndex((i) => Math.max(0, i - 1))}
            onNext={goNext}
          />
        )
      )}
    </Modal>
  )
}

interface QuestionStepProps {
  trip: Trip
  section: SectionWithOptions
  progress: string
  fraction: number
  isFirst: boolean
  isLast: boolean
  onRecord: (id: string, record: StepRecord) => void
  onBack: () => void
  onNext: () => void
}

function QuestionStep({ trip, section, progress, fraction, isFirst, isLast, onRecord, onBack, onNext }: QuestionStepProps) {
  const { control, card } = useQuestionAnswers(trip, section)
  const state = control.myState
  const closed = !control.gate.canAnswer

  // Report this step's state up; the control itself keeps the data in sync.
  useEffect(() => {
    onRecord(section.id, { state, closed })
  }, [onRecord, section.id, state, closed])

  const advance = canAdvance({ state, closed })
  const alreadyAnswered = state !== 'unanswered'

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-[var(--text-secondary)]" aria-live="polite">
            {progress}
          </p>
          {card.chip && (
            <Badge variant={card.chip.tone} size="sm">
              {card.chip.label}
            </Badge>
          )}
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--surface-sunken)]" role="presentation">
          <div className="h-full rounded-full bg-accent-500 transition-all" style={{ width: `${Math.round(fraction * 100)}%` }} />
        </div>
      </div>

      <div>
        <h3 className="text-base font-semibold text-[var(--text-primary)]">{section.title}</h3>
        {section.description && <p className="mt-0.5 text-sm text-[var(--text-secondary)]">{section.description}</p>}
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">{card.subtitle}</p>
      </div>

      <AnswerControl trip={trip} section={section} />

      <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-3">
        <div className="flex gap-1">
          {!isFirst && (
            <Button variant="ghost" onClick={onBack}>
              Back
            </Button>
          )}
          {!alreadyAnswered && !closed && (
            <Button variant="ghost" onClick={onNext}>
              Skip for now
            </Button>
          )}
        </div>
        <Button onClick={onNext} disabled={!advance} title={advance ? undefined : 'Answer to continue, or skip'}>
          {isLast ? 'Finish' : 'Next'}
        </Button>
      </div>
    </div>
  )
}
