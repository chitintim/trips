import { useMemo, useState } from 'react'
import { Badge, Button, Input, Modal, Select, SelectionAvatars, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useUpdateSection } from '../../../lib/queries/usePlanning'
import { useActions, useCreateAction } from '../../../lib/queries/useActions'
import { useTrip } from '../../../lib/queries/useTrip'
import { inScopePeople } from '../../people/lib/inScopePeople'
import { areVotesVisible, checkAutoClose } from '../lib/voting'
import { resolveWinner } from '../lib/resolveDecision'
import { buildDecisionMetadata, followupActionTitle, readFollowupActionId, resolveDecidedOptionId } from '../lib/closeDecision'
import { CloseDecisionSheet } from './CloseDecisionSheet'
import type { OptionVoteWithUser, SectionWithOptions } from '../../../lib/queries/usePlanning'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { TimelineEvent } from '../../../types'

export interface DecisionOutcomePanelProps {
  tripId: string
  section: SectionWithOptions
  votes: OptionVoteWithUser[]
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

  const activeOptions = useMemo(() => section.options.filter((o) => o.status !== 'cancelled'), [section.options])
  const { data: trip } = useTrip(tripId)
  const confirmationEnabled = trip?.confirmation_enabled === true
  // Only active participants' votes count in displayed tallies ("N of M
  // voted"); removed users' leftover rows are ignored. (`participants` is
  // the active list; skip the filter while it is still empty/loading.)
  const sectionVotes = useMemo(() => {
    const optionIds = new Set(activeOptions.map((o) => o.id))
    const activeUserIds = new Set(participants.filter((p) => p.active !== false).map((p) => p.user_id))
    return votes.filter((v) => optionIds.has(v.option_id) && (activeUserIds.size === 0 || activeUserIds.has(v.user_id)))
  }, [activeOptions, votes, participants])
  // Denominator: people who are "in" (shared rule with cost and splits).
  const inScopeCount = useMemo(() => inScopePeople(participants, confirmationEnabled).length, [participants, confirmationEnabled])
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
          {decidedOption ? `✅ Decided: ${decidedOption.title}` : 'Closed — no decision'}
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
                📅 Put it on the plan
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
                ＋ Add a to-do
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
  const leader = votesVisible ? resolveWinner(section, sectionVotes) : null
  const leaderOption = leader?.optionId ? activeOptions.find((o) => o.id === leader.optionId) ?? null : null
  const leaderVotes = leaderOption ? sectionVotes.filter((v) => v.option_id === leaderOption.id && v.user) : []
  const autoClose = checkAutoClose(section, distinctVoters)

  return (
    <>
      <div className="min-w-0 rounded-[var(--radius-md)] border border-dashed border-[var(--border-default)] bg-[var(--surface-sunken)] p-2.5 space-y-1.5">
        <p className="min-w-0 break-words text-xs text-[var(--text-secondary)]">
          {leaderOption
            ? `${leader?.tied ? 'Tied — leading by tie-break' : 'Leading'}: ${leaderOption.title}.`
            : `${distinctVoters} of ${Math.max(inScopeCount, distinctVoters)} answered${votesVisible ? '' : " · Results show when it's decided"}.`}
        </p>
        {leaderOption && leaderVotes.length > 0 && (
          <SelectionAvatars
            selections={leaderVotes.map((v) => ({
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
        {autoClose.shouldClose && isOrganizer && (
          <p className="text-xs font-medium text-warn-700 dark:text-warn-300">
            {autoClose.reason === 'deadline_passed' ? '⏰ The deadline has passed' : '🙌 Quorum reached'} — ready to decide.
          </p>
        )}
        {isOrganizer && (
          <Button size="sm" variant={autoClose.shouldClose ? 'primary' : 'secondary'} onClick={() => setCloseSheetOpen(true)}>
            🏁 Decide
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
        notes: `From the question "${section.title}" — decided: ${winnerTitle}.`,
      })
      await updateSection.mutateAsync({
        id: section.id,
        update: { metadata: buildDecisionMetadata(section.metadata, { followup_action_id: action.id }) },
      })
      showToast({ type: 'success', message: 'To-do added', description: title.trim() })
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not add the to-do', description: (err as Error).message })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" title="Add a to-do">
      <div className="space-y-4">
        <Input label="What needs doing?" value={title} onChange={(e) => setTitle(e.target.value)} required fullWidth />
        <Select
          label="Who does it?"
          value={assignedTo}
          onChange={(e) => setAssignedTo(e.target.value)}
          placeholder="Everyone"
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
            Add to-do
          </Button>
        </div>
      </div>
    </Modal>
  )
}
