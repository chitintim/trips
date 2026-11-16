import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, EmptyState, Skeleton } from '../../../components/ui'
import { NothingToDecide, ErrorState } from '../../../components/ui/illustrations'
import { QuestionCard, QuestionManageSheet } from '../../decisions'
import type { Trip } from '../../../types'
import type { UseQuestionListResult } from '../lib/useQuestionList'
import {
  ANSWER_ALL_SEARCH,
  NOTHING_OPEN_NOTE,
  GROUP_HEADINGS,
  groupHeading,
  questionsEmptyState,
  showAnswerAll,
  type QuestionEntry,
} from '../lib/questionsModel'
import type { SectionWithOptions } from '../../../lib/queries/usePlanning'

export interface QuestionsViewProps {
  trip: Trip
  list: UseQuestionListResult
  /** useTripPermissions().canManageTrip: shows "⋯ Manage" on each card. */
  canManage: boolean
  /** Question card to scroll to and briefly highlight (`?open=question:<id>`). */
  highlight?: { id: string; nonce: number } | null
  /** Organisers' "Ask the group" (opens the Add sheet as a question). */
  onAsk?: () => void
  /** Organisers' starter questions (empty plan). */
  onCreateStarters?: () => void
  creatingStarters?: boolean
  starterTitles?: string[]
}

/**
 * Plan > Questions (proposal 5.1/5.3/5.8): one list of QuestionCard grouped
 * Open -> Decided -> Booked -> Closed. No vote logic here; every answer goes
 * through QuestionCard / AnswerControl / useAnswer.
 */
export function QuestionsView({
  trip,
  list,
  canManage,
  highlight = null,
  onAsk,
  onCreateStarters,
  creatingStarters = false,
  starterTitles = [],
}: QuestionsViewProps) {
  const { groups, bookedOptionIds, isLoading, isError, refetch } = list
  const [manageSectionId, setManageSectionId] = useState<string | null>(null)
  const [doneOpen, setDoneOpen] = useState(false)

  // A deep link into the collapsed Closed group opens it first.
  const highlightId = highlight?.id
  const highlightNonce = highlight?.nonce
  const inDone = !!highlightId && groups.closed.some((e) => e.section.id === highlightId)
  useEffect(() => {
    if (inDone) setDoneOpen(true)
  }, [inDone, highlightNonce])

  // Scroll to and flash the question card named by a deep link.
  const ready = !isLoading
  useEffect(() => {
    if (!highlightId || !ready) return
    let off: ReturnType<typeof setTimeout> | undefined
    let el: HTMLElement | null = null
    const ring = ['ring-2', 'ring-accent-500']
    const on = setTimeout(() => {
      el = document.getElementById(`question-${highlightId}`)
      if (!el) return
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.classList.add(...ring)
      off = setTimeout(() => el?.classList.remove(...ring), 2200)
    }, 200)
    return () => {
      clearTimeout(on)
      clearTimeout(off)
      el?.classList.remove(...ring)
    }
  }, [highlightId, highlightNonce, ready, doneOpen])

  if (isLoading) return <Skeleton variant="card" height={140} />

  if (isError) {
    return (
      <EmptyState
        icon={<ErrorState className="w-24 h-24 text-danger-500" />}
        title="Couldn't load the questions"
        description="Something went wrong. Check your connection and try again."
        action={
          <Button variant="primary" onClick={refetch}>
            Retry
          </Button>
        }
      />
    )
  }

  if (groups.total === 0) {
    const empty = questionsEmptyState(canManage)
    return (
      <EmptyState
        icon={<NothingToDecide className="w-32 h-24 text-[var(--text-muted)]" />}
        title={empty.title}
        description={empty.description}
        action={
          empty.showAsk ? (
            <div className="space-y-3 text-left">
              {onAsk && (
                <Button onClick={onAsk} fullWidth>
                  Ask the group
                </Button>
              )}
              {empty.showStarters && onCreateStarters && starterTitles.length > 0 && (
                <div className="space-y-2">
                  <ul className="text-sm text-[var(--text-secondary)] space-y-1">
                    {starterTitles.map((t) => (
                      <li key={t}>• {t}</li>
                    ))}
                  </ul>
                  <Button variant="secondary" onClick={onCreateStarters} isLoading={creatingStarters} fullWidth>
                    Set up these questions
                  </Button>
                </div>
              )}
            </div>
          ) : undefined
        }
      />
    )
  }

  const card = (entry: QuestionEntry<SectionWithOptions>) => (
    <div key={entry.section.id} id={`question-${entry.section.id}`} className="min-w-0 scroll-mt-20 rounded-[var(--radius-lg)] transition-shadow">
      <QuestionCard
        trip={trip}
        section={entry.section}
        bookedOptionIds={bookedOptionIds}
        onManage={canManage ? () => setManageSectionId(entry.section.id) : undefined}
      />
    </div>
  )

  return (
    <div className="space-y-5">
      {showAnswerAll(groups.needsAnswerCount) && (
        <Link
          to={ANSWER_ALL_SEARCH}
          className="block w-full rounded-[var(--radius-xl)] border border-accent-300 bg-accent-50 dark:bg-accent-950/30 p-4 hover:border-accent-400 transition-colors"
        >
          <span className="text-base font-semibold text-[var(--text-primary)]">Answer all ({groups.needsAnswerCount})</span>
          <span className="block mt-0.5 text-sm text-accent-700 dark:text-accent-400">One question at a time →</span>
        </Link>
      )}

      {groups.open.length > 0 ? (
        <section aria-label={groupHeading('Open', groups.open.length)} className="space-y-2">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{groupHeading('Open', groups.open.length)}</h3>
          {groups.open.map(card)}
        </section>
      ) : (
        <p className="text-sm text-[var(--text-muted)]">{NOTHING_OPEN_NOTE}</p>
      )}

      {groups.decided.length > 0 && (
        <section aria-label={groupHeading('Decided', groups.decided.length)} className="space-y-2">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{groupHeading('Decided', groups.decided.length)}</h3>
          {groups.decided.map(card)}
        </section>
      )}

      {groups.booked.length > 0 && (
        <section aria-label={groupHeading(GROUP_HEADINGS.booked, groups.booked.length)} className="space-y-2">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{groupHeading(GROUP_HEADINGS.booked, groups.booked.length)}</h3>
          {groups.booked.map(card)}
        </section>
      )}

      {groups.closed.length > 0 && (
        <section aria-label={groupHeading(GROUP_HEADINGS.closed, groups.closed.length)} className="space-y-2">
          <button
            type="button"
            onClick={() => setDoneOpen((v) => !v)}
            aria-expanded={doneOpen}
            className="flex w-full items-center justify-between gap-2 text-left text-sm font-semibold text-[var(--text-primary)]"
          >
            <span>{groupHeading(GROUP_HEADINGS.closed, groups.closed.length)}</span>
            <span aria-hidden="true" className="text-xs font-normal text-[var(--text-muted)]">
              {doneOpen ? '▲ Hide' : '▾ Show'}
            </span>
          </button>
          {doneOpen && groups.closed.map(card)}
        </section>
      )}

      {manageSectionId && (
        <QuestionManageSheet isOpen onClose={() => setManageSectionId(null)} tripId={trip.id} sectionId={manageSectionId} />
      )}
    </div>
  )
}
