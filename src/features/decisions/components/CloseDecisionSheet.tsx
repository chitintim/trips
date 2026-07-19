import { useEffect, useMemo, useState } from 'react'
import { Badge, Button, Modal, useToast } from '../../../components/ui'
import { useUpdateSection } from '../../../lib/queries/usePlanning'
import { useTripActivityLog } from '../../organizer/lib/activity'
import { tallyVotes, votingInstruction, type VotingMethod } from '../lib/voting'
import { buildDecisionMetadata, resolveTallyLeaderId } from '../lib/closeDecision'
import type { OptionVote, SectionWithOptions } from '../../../lib/queries/usePlanning'

export interface CloseDecisionSheetProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  section: SectionWithOptions
  votes: OptionVote[]
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

  const leaderId = useMemo(() => resolveTallyLeaderId(section, votes), [section, votes])
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
      showToast({ type: 'success', message: 'Decision closed', description: winner ? `Decided: ${winner.title}` : undefined })
      onClose()
      if (winner) onClosed?.(selectedId)
    } catch (err) {
      showToast({ type: 'error', message: 'Could not close this decision', description: (err as Error).message })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md" title={`Close "${section.title}"`}>
      <div className="space-y-4">
        <p className="text-sm text-[var(--text-secondary)]">
          Pick the winning option — the tally leader is pre-selected. Closing records the outcome, reveals the results to
          everyone and ends voting.
        </p>

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
                        : `${tally?.score ?? 0} vote${(tally?.score ?? 0) === 1 ? '' : 's'}`}
                    </span>
                    {isLeader && (
                      <Badge variant="info" size="sm">
                        Leading
                      </Badge>
                    )}
                  </span>
                </span>
              </button>
            )
          })}
        </div>

        <p className="text-xs text-[var(--text-muted)]">This poll was «{votingInstruction(method)}».</p>

        <div className="flex justify-end gap-3 border-t border-[var(--border-subtle)] pt-3">
          <Button variant="ghost" onClick={onClose} disabled={updateSection.isPending}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} isLoading={updateSection.isPending} disabled={!selectedId}>
            🏁 Close &amp; decide
          </Button>
        </div>
      </div>
    </Modal>
  )
}
