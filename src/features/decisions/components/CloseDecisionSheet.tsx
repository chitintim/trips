import { useEffect, useMemo, useState } from 'react'
import { Badge, Button, Modal, SelectionAvatars, useToast } from '../../../components/ui'
import { useUpdateSection } from '../../../lib/queries/usePlanning'
import { useTripActivityLog } from '../../organizer/lib/activity'
import { tallyVotes, votingInstruction, type VotingMethod } from '../lib/voting'
import { buildDecisionMetadata, resolveTieInfo } from '../lib/closeDecision'
import type { OptionVoteWithUser, SectionWithOptions } from '../../../lib/queries/usePlanning'

export interface CloseDecisionSheetProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  section: SectionWithOptions
  votes: OptionVoteWithUser[]
  /** Called after the section is successfully closed, with the winning option id. */
  onClosed?: (decidedOptionId: string) => void
}

/**
 * Organizer "close & decide" flow (plan §7's "organizer confirms" half —
 * checkAutoClose only ever *reports* readiness): shows the tally, pre-
 * selects the current leader, lets the organizer override it, and on
 * confirm marks the section completed with `metadata.decided_option_id`
 * stamped (see closeDecision.ts) + a poll_closed activity entry. Closing
 * reveals results to everyone (areVotesVisible treats completed/deadline-
 * passed sections as visible), which the sheet calls out.
 */
export function CloseDecisionSheet({ isOpen, onClose, tripId, section, votes, onClosed }: CloseDecisionSheetProps) {
  const { showToast } = useToast()
  const updateSection = useUpdateSection(tripId)
  const logActivity = useTripActivityLog(tripId)

  const method = (section.voting_method as VotingMethod) || 'single'
  const activeOptions = useMemo(() => section.options.filter((o) => o.status !== 'cancelled'), [section.options])

  const tallies = useMemo(() => {
    const optionIds = activeOptions.map((o) => o.id)
    const sectionVotes = votes.filter((v) => optionIds.includes(v.option_id))
    const byOption = new Map(tallyVotes(optionIds, sectionVotes, method).map((t) => [t.optionId, t]))
    return byOption
  }, [activeOptions, votes, method])

  /** Voters (with user embedded) per option, for the avatar row below each tally — same source as `tallies`, just not collapsed to a score. */
  const votersByOption = useMemo(() => {
    const byOption = new Map<string, OptionVoteWithUser[]>()
    for (const v of votes) {
      if (!v.user) continue
      const list = byOption.get(v.option_id)
      if (list) list.push(v)
      else byOption.set(v.option_id, [v])
    }
    return byOption
  }, [votes])

  const tie = useMemo(() => resolveTieInfo(section, votes), [section, votes])
  const leaderId = tie.pickedOptionId
  const tiedTitles = useMemo(
    () => tie.tiedOptionIds.map((id) => activeOptions.find((o) => o.id === id)?.title).filter((t): t is string => !!t),
    [tie.tiedOptionIds, activeOptions]
  )
  const tiePickTitle = activeOptions.find((o) => o.id === tie.pickedOptionId)?.title
  const [selectedId, setSelectedId] = useState<string | null>(leaderId)

  useEffect(() => {
    if (isOpen) setSelectedId(leaderId ?? activeOptions[0]?.id ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, section.id])

  const handleConfirm = async () => {
    if (!selectedId) return
    const winner = activeOptions.find((o) => o.id === selectedId)
    try {
      await updateSection.mutateAsync({
        id: section.id,
        update: {
          status: 'completed',
          metadata: buildDecisionMetadata(section.metadata, { decided_option_id: selectedId }),
        },
      })
      logActivity({
        verb: 'poll_closed',
        entity: { type: 'section', id: section.id, label: section.title },
        metadata: { decided_option_id: selectedId, decided_option_title: winner?.title },
      })
      showToast({ type: 'success', message: winner ? `Decided: ${winner.title}` : 'Closed — no decision' })
      onClose()
      if (winner) onClosed?.(selectedId)
    } catch (err) {
      showToast({ type: 'error', message: 'Could not decide this question', description: (err as Error).message })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md" title={`Decide "${section.title}"`}>
      <div className="space-y-4">
        <p className="text-sm text-[var(--text-secondary)]">
          Choose the winning option — the leader is pre-selected. Deciding records the answer, shows everyone the results
          and closes the question.
        </p>

        {tie.tied && (
          <div role="status" className="rounded-[var(--radius-md)] border border-warning-300 bg-warning-50 dark:bg-warning-900/30 p-2.5 text-sm text-[var(--text-primary)]">
            <p className="font-medium">Tied</p>
            <p className="mt-0.5 break-words text-xs text-[var(--text-secondary)]">
              {tiedTitles.join(', ')} are level.{' '}
              {tiePickTitle ? `The automatic tie-break picks "${tiePickTitle}". ` : ''}
              Choose a different option below if you would rather decide it yourself.
            </p>
          </div>
        )}

        <div role="radiogroup" aria-label="Winning option" className="space-y-2">
          {activeOptions.map((option) => {
            const tally = tallies.get(option.id)
            const isSelected = selectedId === option.id
            const isLeader = leaderId === option.id
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() => setSelectedId(option.id)}
                className={`w-full min-w-0 flex items-start gap-3 rounded-[var(--radius-lg)] border p-3 text-left transition-colors ${
                  isSelected
                    ? 'border-accent-500 bg-accent-50 dark:bg-accent-950/30'
                    : 'border-[var(--border-default)] hover:border-accent-300'
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
                      {method === 'ranked'
                        ? `${tally?.score ?? 0} point${(tally?.score ?? 0) === 1 ? '' : 's'}`
                        : `${tally?.score ?? 0} answer${(tally?.score ?? 0) === 1 ? '' : 's'}`}
                    </span>
                    {tie.tied && tie.tiedOptionIds.includes(option.id) ? (
                      <Badge variant="warning" size="sm">
                        {isLeader ? 'Tied · tie-break pick' : 'Tied'}
                      </Badge>
                    ) : (
                      isLeader && (
                        <Badge variant="info" size="sm">
                          Leading
                        </Badge>
                      )
                    )}
                    {(votersByOption.get(option.id) || []).length > 0 && (
                      <SelectionAvatars
                        selections={(votersByOption.get(option.id) || []).map((v) => ({
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

        <div className="flex justify-end gap-3 border-t border-[var(--border-subtle)] pt-3">
          <Button variant="ghost" onClick={onClose} disabled={updateSection.isPending}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} isLoading={updateSection.isPending} disabled={!selectedId}>
            🏁 Decide
          </Button>
        </div>
      </div>
    </Modal>
  )
}
