import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge, Button, Input, Modal, Select, SelectionAvatars, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useParticipants } from '../../../lib/queries/useTrip'
import { useVotes } from '../../../lib/queries/usePlanning'
import { useDecideQuestion } from '../../../lib/queries/useDecide'
import { isOwnChoice } from '../../../lib/answers/answers'
import { tallyVotes, votingInstruction, type VotingMethod } from '../lib/voting'
import { resolveTieInfo } from '../lib/closeDecision'
import { participantName } from '../lib/everyonesAnswers'
import { buildDecideInput, decideBlocker, decideDefaults, decideToastMessage, readOptionPlanDate } from '../lib/decideSheetModel'
import { PlanWhenFields } from './PlanWhenFields'
import type { OptionVoteWithUser, SectionWithOptions } from '../../../lib/queries/usePlanning'
import type { Trip } from '../../../types'

export interface DecideSheetProps {
  isOpen: boolean
  onClose: () => void
  trip: Trip
  section: SectionWithOptions
  /** Preselect this option instead of the leader (the item sheet's "Decide" on one option). */
  initialOptionId?: string | null
}

function ToggleRow({ checked, onChange, title, hint, children }: { checked: boolean; onChange: (v: boolean) => void; title: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border-default)] p-3">
      <label className="flex cursor-pointer items-start gap-3">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-accent-600" />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-[var(--text-primary)]">{title}</span>
          {hint && <span className="block text-xs text-[var(--text-muted)]">{hint}</span>}
        </span>
      </label>
      {checked && children && <div className="mt-3 space-y-3">{children}</div>}
    </div>
  )
}

/**
 * The ONE organiser decision step (proposal 5.6): pick the winner (the leader is
 * preselected under the single winner rule; a tie preselects nothing and needs an explicit choice), then three
 * optional extras in one place -- "Put it on the plan" and "Add a to-do to book
 * it" -- and ONE "Decide" button. Everything is sent in a single atomic
 * `decide_question` call (useDecideQuestion), so a failure never leaves a closed
 * question without a winner. Own choice has no winner: it is "Close answers".
 *
 * ("Tell the group" is not offered: the RPC has no such field; the group
 * already sees the decision in the activity feed and on the question card.)
 */
export function DecideSheet({ isOpen, onClose, trip, section, initialOptionId = null }: DecideSheetProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const navigate = useNavigate()
  const decide = useDecideQuestion(trip.id)
  const { data: votesData } = useVotes(trip.id)
  const { data: participantsData } = useParticipants(trip.id)

  const own = isOwnChoice(section)
  const method = (section.voting_method as VotingMethod) || 'single'
  const activeOptions = useMemo(() => section.options.filter((o) => o.status !== 'cancelled'), [section.options])
  const sectionVotes = useMemo(() => {
    const ids = new Set(activeOptions.map((o) => o.id))
    return (votesData ?? []).filter((v) => ids.has(v.option_id)) as OptionVoteWithUser[]
  }, [votesData, activeOptions])

  const tallies = useMemo(() => new Map(tallyVotes(activeOptions.map((o) => o.id), sectionVotes, method).map((t) => [t.optionId, t])), [activeOptions, sectionVotes, method])
  const votersByOption = useMemo(() => {
    const byOption = new Map<string, OptionVoteWithUser[]>()
    for (const v of sectionVotes) {
      if (!v.user) continue
      const list = byOption.get(v.option_id)
      if (list) list.push(v)
      else byOption.set(v.option_id, [v])
    }
    return byOption
  }, [sectionVotes])

  const tie = useMemo(() => resolveTieInfo(section, sectionVotes), [section, sectionVotes])
  const leaderId = tie.pickedOptionId
  const tiedTitles = tie.tiedOptionIds.map((id) => activeOptions.find((o) => o.id === id)?.title).filter((t): t is string => !!t)

  // Everything below is "the viewer's override, else the default"; overrides clear on every open.
  const [pickId, setPickId] = useState<string | null>(null)
  const [ov, setOv] = useState<{ plan?: boolean; todo?: boolean; date?: string; time?: string; who?: string; due?: string }>({})
  useEffect(() => {
    if (isOpen) {
      setPickId(null)
      setOv({})
    }
  }, [isOpen, section.id])
  const selectedId = pickId ?? (initialOptionId && activeOptions.some((o) => o.id === initialOptionId) ? initialOptionId : (tie.tied ? null : (leaderId ?? activeOptions[0]?.id ?? null)))
  const selected = activeOptions.find((o) => o.id === selectedId) ?? null

  const optionDate = selected ? readOptionPlanDate(selected.metadata, section.metadata) : null
  const defaults = decideDefaults({ sectionType: section.section_type, optionDate })
  const putOnPlan = ov.plan ?? defaults.putOnPlan
  const bookTodo = ov.todo ?? defaults.bookTodo
  const date = ov.date ?? optionDate?.date ?? trip.start_date
  const startTime = ov.time ?? optionDate?.startTime ?? ''
  const who = ov.who ?? 'me'
  const dueDate = ov.due ?? ''
  const patch = (p: Partial<typeof ov>) => setOv((prev) => ({ ...prev, ...p }))

  const assignable = (participantsData ?? []).filter((p) => p.active !== false && p.confirmation_status !== 'declined' && p.confirmation_status !== 'cancelled' && p.user_id !== user?.id)
  const assignedTo = who === 'me' ? (user?.id ?? null) : who

  const form = { sectionId: section.id, own, optionId: selectedId, putOnPlan, date, startTime, bookTodo, assignedTo, dueDate }
  const blocker = decideBlocker(form, tie.tied)

  const handleConfirm = async () => {
    if (blocker) return
    try {
      const result = await decide.mutateAsync(buildDecideInput(form))
      const toast = decideToastMessage({
        own,
        sectionTitle: section.title,
        optionTitle: selected?.title ?? null,
        planDate: putOnPlan ? date : null,
        result,
      })
      showToast({
        type: 'success',
        ...toast,
        action: { label: 'View', onClick: () => navigate(`/${trip.id}?open=question:${section.id}`) },
      })
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: own ? 'Could not close this question' : 'Could not decide this question', description: (err as Error).message })
    }
  }

  if (own) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} size="sm" title={`Close answers: "${section.title}"`}>
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            Everyone chooses for themselves, so there is no winner. Closing stops new and changed answers; what people chose stays visible. You can reopen it later.
          </p>
          <div className="flex justify-end gap-3 border-t border-[var(--border-subtle)] pt-3">
            <Button variant="ghost" onClick={onClose} disabled={decide.isPending}>
              Cancel
            </Button>
            <Button onClick={handleConfirm} isLoading={decide.isPending}>
              Close answers
            </Button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md" title={`Decide "${section.title}"`}>
      <div className="space-y-4">
        <p className="text-sm text-[var(--text-secondary)]">Choose the winner. This closes the question and shows everyone the results.</p>

        {tie.tied && (
          <div role="status" className="rounded-[var(--radius-md)] border border-warning-300 bg-warning-50 p-2.5 text-sm text-[var(--text-primary)] dark:bg-warning-900/30">
            <p className="font-medium">Tied</p>
            <p className="mt-0.5 break-words text-xs text-[var(--text-secondary)]">
              {tiedTitles.join(', ')} are level. Choose the winner below; nothing is picked for you.
            </p>
          </div>
        )}

        <div role="radiogroup" aria-label="Winning option" className="space-y-2">
          {activeOptions.map((option) => {
            const tally = tallies.get(option.id)
            const isSelected = selectedId === option.id
            const isLeader = leaderId === option.id
            const score = tally?.score ?? 0
            const voters = votersByOption.get(option.id) ?? []
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() => setPickId(option.id)}
                className={`flex w-full min-w-0 items-start gap-3 rounded-[var(--radius-lg)] border p-3 text-left transition-colors ${
                  isSelected ? 'border-accent-500 bg-accent-50 dark:bg-accent-950/30' : 'border-[var(--border-default)] hover:border-accent-300'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 ${
                    isSelected ? 'border-accent-600 bg-accent-600 shadow-[inset_0_0_0_2.5px_var(--surface-raised)]' : 'border-[var(--border-default)]'
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block break-words font-medium text-[var(--text-primary)]">{option.title}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-[var(--text-muted)]">
                      {method === 'ranked' ? `${score} point${score === 1 ? '' : 's'}` : `${score} answer${score === 1 ? '' : 's'}`}
                    </span>
                    {tie.tied && tie.tiedOptionIds.includes(option.id) ? (
                      <Badge variant="warning" size="sm">
                        Tied
                      </Badge>
                    ) : (
                      isLeader && (
                        <Badge variant="info" size="sm">
                          Leading
                        </Badge>
                      )
                    )}
                    {voters.length > 0 && (
                      <SelectionAvatars
                        selections={voters.map((v) => ({
                          id: v.id,
                          selected_at: v.created_at ?? undefined,
                          user: v.user
                            ? {
                                full_name: v.user.full_name ?? undefined,
                                email: v.user.email ?? undefined,
                                avatar_url: v.user.avatar_url ?? undefined,
                                avatar_data: (v.user.avatar_data as { emoji: string; bgColor: string } | null) ?? undefined,
                              }
                            : undefined,
                        }))}
                        maxAvatars={4}
                        size="sm"
                        entityLabel="chose this"
                      />
                    )}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
        <p className="text-xs text-[var(--text-muted)]">Answered as: {votingInstruction(method)}.</p>

        <div className="space-y-2">
          <ToggleRow checked={putOnPlan} onChange={(v) => patch({ plan: v })} title="Put it on the plan" hint={optionDate ? 'This option already has a date.' : 'Give the winner a day on the plan.'}>
            <PlanWhenFields tripStart={trip.start_date} tripEnd={trip.end_date} date={date} startTime={startTime} onDateChange={(v) => patch({ date: v })} onStartTimeChange={(v) => patch({ time: v })} />
          </ToggleRow>
          <ToggleRow checked={bookTodo} onChange={(v) => patch({ todo: v })} title="Add a to-do to book it" hint="Someone gets “Book: …” on their list.">
            <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
              <Select
                label="Who books it?"
                value={who}
                onChange={(e) => patch({ who: e.target.value })}
                fullWidth
                options={[{ value: 'me', label: 'Me' }, ...assignable.map((p) => ({ value: p.user_id, label: participantName(p) }))]}
              />
              <Input label="Book by (optional)" type="date" value={dueDate} onChange={(e) => patch({ due: e.target.value })} fullWidth />
            </div>
          </ToggleRow>
        </div>

        {blocker && <p className="text-xs text-[var(--text-muted)]">{blocker}</p>}

        <div className="flex justify-end gap-3 border-t border-[var(--border-subtle)] pt-3">
          <Button variant="ghost" onClick={onClose} disabled={decide.isPending}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} isLoading={decide.isPending} disabled={!!blocker}>
            {selected ? `Decide: ${selected.title}` : 'Decide'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
