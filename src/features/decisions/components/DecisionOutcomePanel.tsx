import { useMemo, useState } from 'react'
import { Badge, Button, Input, Modal, Select, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useUpdateSection } from '../../../lib/queries/usePlanning'
import { useActions, useCreateAction } from '../../../lib/queries/useActions'
import { areVotesVisible, checkAutoClose, tallyVotes, getWinner, type VotingMethod } from '../lib/voting'
import { buildDecisionMetadata, followupActionTitle, readFollowupActionId, resolveDecidedOptionId } from '../lib/closeDecision'
import { CloseDecisionSheet } from './CloseDecisionSheet'
import type { OptionVote, SectionWithOptions } from '../../../lib/queries/usePlanning'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { TimelineEvent } from '../../../types'

export interface DecisionOutcomePanelProps {
  tripId: string
  section: SectionWithOptions
  votes: OptionVote[]
  participants: ParticipantWithUser[]
  isOrganizer: boolean
  /** Timeline events — used to detect that the decided option is already scheduled (source_option_id absorption). */
  events: TimelineEvent[]
  /** Host surface opens its ScheduleItSheet for this option ("put it on the plan"). Omit to hide the affordance. */
  onScheduleOption?: (optionId: string) => void
}

/**
 * The "→ what happens once this is decided" area rendered UNDER a group-vote
 * question's options (mobile-first clarity ask: options and outcome were
 * visually one undifferentiated pile, and the old bare "Schedule ..." button
 * overflowed narrow screens):
 *
 *  - OPEN section → a dashed "Outcome" box: live status (leader when votes
 *    are visible, plain progress when hidden), auto-close readiness, and the
 *    organizer's "Close & decide" entry point (CloseDecisionSheet).
 *  - CLOSED section → a solid "Decided: X" banner plus the decision's
 *    consequences: on-the-plan status (or "Schedule it"), and a linked
 *    follow-up action ("Tim books it") created right here and stamped into
 *    section metadata as followup_action_id.
 *
 * Everything wraps (min-w-0/break-words/flex-wrap) so long option titles
 * never spill outside the card at 375px.
 */
export function DecisionOutcomePanel({
  tripId,
  section,
  votes,
  participants,
  isOrganizer,
  events,
  onScheduleOption,
}: DecisionOutcomePanelProps) {
  const [closeSheetOpen, setCloseSheetOpen] = useState(false)
  const [followupOpen, setFollowupOpen] = useState(false)
  const { data: actions } = useActions(tripId)

  const method = (section.voting_method as VotingMethod) || 'single'
  const activeOptions = useMemo(() => section.options.filter((o) => o.status !== 'cancelled'), [section.options])
  const sectionVotes = useMemo(() => {
    const optionIds = new Set(activeOptions.map((o) => o.id))
    return votes.filter((v) => optionIds.has(v.option_id))
  }, [activeOptions, votes])
  const distinctVoters = useMemo(() => new Set(sectionVotes.map((v) => v.user_id)).size, [sectionVotes])

  const isClosed = section.status === 'completed'
  const decidedOptionId = useMemo(() => resolveDecidedOptionId(section, votes), [section, votes])
  const decidedOption = decidedOptionId ? section.options.find((o) => o.id === decidedOptionId) ?? null : null

  // ---- Closed: "Decided" banner + consequences -----------------------------
  if (isClosed) {
    const scheduledEvent = decidedOptionId ? events.find((e) => e.source_option_id === decidedOptionId) ?? null : null
    const followupActionId = readFollowupActionId(section.metadata)
    const followupAction = followupActionId ? (actions || []).find((a) => a.id === followupActionId) ?? null : null

    return (
      <div className="min-w-0 rounded-[var(--radius-md)] border border-success-200 dark:border-success-800 bg-success-50 dark:bg-success-900/30 p-2.5 space-y-2">
        <p className="min-w-0 break-words text-sm font-medium text-success-700 dark:text-success-300">
          ✅ Decided{decidedOption ? `: ${decidedOption.title}` : ' — closed without a winner'}
        </p>

        <div className="flex flex-wrap items-center gap-1.5">
          {scheduledEvent ? (
            <Badge variant="success" size="sm" wrap>
              📅 On the plan ·{' '}
              {new Date(`${scheduledEvent.event_date}T00:00:00`).toLocaleDateString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
              })}
            </Badge>
          ) : (
            decidedOption &&
            isOrganizer &&
            onScheduleOption && (
              <Button size="sm" variant="secondary" onClick={() => onScheduleOption(decidedOption.id)}>
                📅 Schedule it
              </Button>
            )
          )}

          {followupAction ? (
            <Badge variant={followupAction.completed_at ? 'success' : 'neutral'} size="sm" wrap>
              {followupAction.completed_at ? '✅' : '☑️'} {followupAction.title}
              {followupOwnerName(followupAction.assigned_to, participants) ? ` — ${followupOwnerName(followupAction.assigned_to, participants)}` : ''}
            </Badge>
          ) : (
            decidedOption &&
            isOrganizer && (
              <Button size="sm" variant="ghost" onClick={() => setFollowupOpen(true)}>
                ＋ Follow-up action
              </Button>
            )
          )}
        </div>

        {decidedOption && (
          <FollowupActionModal
            isOpen={followupOpen}
            onClose={() => setFollowupOpen(false)}
            tripId={tripId}
            section={section}
            winnerTitle={decidedOption.title}
            participants={participants}
          />
        )}
      </div>
    )
  }

  // ---- Open: outcome preview + organizer close entry point -----------------
  const votesVisible = areVotesVisible(section)
  const leader = votesVisible ? getWinner(tallyVotes(activeOptions.map((o) => o.id), sectionVotes, method)) : null
  const leaderOption = leader ? activeOptions.find((o) => o.id === leader.optionId) ?? null : null
  const autoClose = checkAutoClose(section, distinctVoters)

  return (
    <>
      <div className="min-w-0 rounded-[var(--radius-md)] border border-dashed border-[var(--border-default)] bg-[var(--surface-sunken)] p-2.5 space-y-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">→ Once decided</p>
        <p className="min-w-0 break-words text-xs text-[var(--text-secondary)]">
          {leaderOption
            ? `Leading: ${leaderOption.title}. `
            : `${distinctVoters} of ${participants.length} voted${votesVisible ? '' : ' · results hidden until the vote closes'}. `}
          {isOrganizer
            ? 'Close the vote to lock in the winner — it can then be scheduled and given a follow-up action.'
            : 'The organizer closes the vote, then the winner goes on the plan.'}
        </p>
        {autoClose.shouldClose && isOrganizer && (
          <p className="text-xs font-medium text-warn-700 dark:text-warn-300">
            {autoClose.reason === 'deadline_passed' ? '⏰ The deadline has passed' : '🙌 Quorum reached'} — ready to close.
          </p>
        )}
        {isOrganizer && (
          <Button size="sm" variant={autoClose.shouldClose ? 'primary' : 'secondary'} onClick={() => setCloseSheetOpen(true)}>
            🏁 Close &amp; decide
          </Button>
        )}
      </div>

      <CloseDecisionSheet
        isOpen={closeSheetOpen}
        onClose={() => setCloseSheetOpen(false)}
        tripId={tripId}
        section={section}
        votes={votes}
      />
    </>
  )
}

function followupOwnerName(assignedTo: string | null, participants: ParticipantWithUser[]): string | null {
  if (!assignedTo) return null
  const p = participants.find((p) => p.user_id === assignedTo)
  return p?.user?.full_name || p?.user?.email || null
}

interface FollowupActionModalProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  section: SectionWithOptions
  winnerTitle: string
  participants: ParticipantWithUser[]
}

/**
 * Minimal create-linked-action form: title (prefilled 'Book "X"'), owner,
 * optional due date. Creates a trip_actions row and stamps its id into the
 * section's metadata (followup_action_id) so the outcome banner can show
 * "Book X — Tim" from then on. Deliberately not a workflow engine.
 */
function FollowupActionModal({ isOpen, onClose, tripId, section, winnerTitle, participants }: FollowupActionModalProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const createAction = useCreateAction(tripId)
  const updateSection = useUpdateSection(tripId)

  const [title, setTitle] = useState(() => followupActionTitle(winnerTitle))
  const [assignedTo, setAssignedTo] = useState('')
  const [dueDate, setDueDate] = useState('')

  const handleCreate = async () => {
    if (!user || !title.trim()) return
    try {
      const action = await createAction.mutateAsync({
        title: title.trim(),
        created_by: user.id,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        deadline_kind: 'fixed',
        notes: `Follow-up from the decision "${section.title}" — decided: ${winnerTitle}.`,
      })
      await updateSection.mutateAsync({
        id: section.id,
        update: { metadata: buildDecisionMetadata(section.metadata, { followup_action_id: action.id }) },
      })
      showToast({ type: 'success', message: 'Follow-up action created', description: title.trim() })
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not create the follow-up action', description: (err as Error).message })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" title="Follow-up action">
      <div className="space-y-4">
        <Input label="What needs doing?" value={title} onChange={(e) => setTitle(e.target.value)} required fullWidth />
        <Select
          label="Who does it?"
          value={assignedTo}
          onChange={(e) => setAssignedTo(e.target.value)}
          placeholder="Whole group"
          fullWidth
          options={participants.map((p) => ({
            value: p.user_id,
            label: p.user?.full_name || p.user?.email || 'Unknown',
          }))}
        />
        <Input label="Due date (optional)" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} fullWidth />
        <div className="flex justify-end gap-3 border-t border-[var(--border-subtle)] pt-3">
          <Button variant="ghost" onClick={onClose} disabled={createAction.isPending || updateSection.isPending}>
            Cancel
          </Button>
          <Button onClick={handleCreate} isLoading={createAction.isPending || updateSection.isPending} disabled={!title.trim()}>
            Create action
          </Button>
        </div>
      </div>
    </Modal>
  )
}
