import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { NeedsAttentionItem } from '../../components/layout'
import { useTrip, useParticipants } from './useTrip'
import { useSections, useVotes } from './usePlanning'
import { useExpenses } from './useExpenses'
import { useSettlements } from './useSettlements'
import { useActions } from './useActions'
import { getDecisionShape } from '../../features/decisions/lib/decisionShapes'
import { isConfirmationEnabled } from '../tripStatus'
import { daysUntilDue, isActionCompleteForUser, isOverdue } from '../../features/actions/lib/actionStatus'

/**
 * Computes the current user's open loops for a trip, purely by reading
 * already-cached TanStack Query data (no extra network calls beyond what
 * the tab hooks already fetch) — this hook is meant to be mounted
 * alongside the hooks it depends on (they share query keys/cache, so if
 * this is the first consumer it will trigger its own fetches, which is
 * fine and expected on the trip home screen).
 *
 * Blockers surfaced (per UPGRADE_MASTER_PLAN §6/§14):
 * - pending RSVP: confirmation_status 'pending', or 'conditional' whose
 *   conditional_date has arrived (the promised date is the trigger)
 * - open polls: vote_deadline in the future, no option_votes row from this
 *   user on any option in that section
 * - unclaimed itemized expenses: expense.participant_ids (or trip
 *   participants, itemized fallback) includes the user, and at least one
 *   line item is not fully claimed and the user hasn't claimed anything
 *   themselves on it
 * - settlements involving the user with status 'suggested' or
 *   'marked_paid' (i.e. not yet 'confirmed')
 *
 * `onNavigateTab`, if provided, is called with the v2 tab registry id
 * (e.g. 'people', 'decisions', 'money') instead of the default
 * `navigate(/:tripId?tab=...)` behavior — TripDetail passes its
 * `setActiveTab` here so a tap switches the in-page tab state directly
 * rather than round-tripping through the URL/legacy tab ids. Callers that
 * only read `.count` (e.g. dashboard TripCard) can omit it.
 */
export function useNeedsAttention(
  tripId: string | undefined,
  onNavigateTab?: (tabId: string) => void
): NeedsAttentionItem[] {
  const { user } = useAuth()
  const navigate = useNavigate()

  const { data: trip } = useTrip(tripId)
  const { data: participants } = useParticipants(tripId)
  const { data: sections } = useSections(tripId)
  const { data: votes } = useVotes(tripId)
  const { data: expensesData } = useExpenses(tripId)
  const { data: settlements } = useSettlements(tripId)
  const { data: actions } = useActions(tripId)

  return useMemo(() => {
    if (!tripId || !user) return []

    const items: NeedsAttentionItem[] = []
    const now = Date.now()

    // ---- Pending RSVP (only when the trip actually tracks confirmation) --
    const myParticipant = participants?.find((p) => p.user_id === user.id)
    if (myParticipant && isConfirmationEnabled(trip)) {
      const isPending = myParticipant.confirmation_status === 'pending'
      const isDueConditional =
        myParticipant.confirmation_status === 'conditional' &&
        !!myParticipant.conditional_date &&
        new Date(myParticipant.conditional_date).getTime() <= now
      if (isPending || isDueConditional) {
        items.push({
          icon: '📝',
          label: isDueConditional ? 'Confirm your status' : "You haven't confirmed",
          count: 1,
          onClick: () => (onNavigateTab ? onNavigateTab('people') : navigate(`/${tripId}?tab=people`)),
        })
      }
    }

    // ---- Open polls not yet voted in ---------------------------------
    // Shape-aware (UX_REDESIGN.md Part 5 + the legacy-data migration
    // 20260707160000_legacy_sections_to_personal): a decision_shape:
    // 'personal' section is never a poll — option_votes never gets a row
    // for it — so "have I responded?" must check `selections` instead of
    // `votes`, or every personal-order section with a deadline would chase
    // forever even after the participant has picked their items.
    const myVotedOptionIds = new Set((votes || []).filter((v) => v.user_id === user.id).map((v) => v.option_id))
    let openPollCount = 0
    for (const section of sections || []) {
      if (!section.vote_deadline) continue
      if (new Date(section.vote_deadline).getTime() <= now) continue
      if ((section.options || []).length === 0) continue
      const hasResponded =
        getDecisionShape(section.metadata) === 'personal'
          ? (section.options || []).some((o) => o.selections.some((s) => s.user_id === user.id))
          : (section.options || []).some((o) => myVotedOptionIds.has(o.id))
      if (!hasResponded) openPollCount++
    }
    if (openPollCount > 0) {
      items.push({
        icon: '🗳️',
        label: 'Unvoted polls',
        count: openPollCount,
        onClick: () => (onNavigateTab ? onNavigateTab('decisions') : navigate(`/${tripId}?tab=decisions`)),
      })
    }

    // ---- Unclaimed itemized expenses ---------------------------------
    let unclaimedCount = 0
    for (const expense of expensesData?.expenses || []) {
      if (!expense.ai_parsed || !expense.status) continue
      if (expense.status === 'allocated' || expense.status === 'confirmed') continue

      const isInvolved = expense.participant_ids
        ? expense.participant_ids.includes(user.id)
        : true // fallback: itemized expenses without explicit tagging chase everyone

      if (!isInvolved) continue

      const myClaims = (expense.claims || []).filter((c) => c.user_id === user.id)
      if (myClaims.length === 0) unclaimedCount++
    }
    if (unclaimedCount > 0) {
      items.push({
        icon: '🧾',
        label: 'Unclaimed items',
        count: unclaimedCount,
        onClick: () => (onNavigateTab ? onNavigateTab('money') : navigate(`/${tripId}?tab=money`)),
      })
    }

    // ---- Settlements involving the user, not yet confirmed -----------
    const myOpenSettlements = (settlements || []).filter(
      (s) =>
        (s.from_user_id === user.id || s.to_user_id === user.id) &&
        (s.status === 'suggested' || s.status === 'marked_paid')
    )
    if (myOpenSettlements.length > 0) {
      items.push({
        icon: '💸',
        label: 'Unpaid settlements',
        count: myOpenSettlements.length,
        onClick: () => (onNavigateTab ? onNavigateTab('money') : navigate(`/${tripId}?tab=money`)),
      })
    }

    // ---- Actions overdue or due within 48h, assigned to the user or a --
    // ---- group action they haven't confirmed yet -----------------------
    let urgentActionCount = 0
    for (const action of actions || []) {
      const isMine = action.assigned_to ? action.assigned_to === user.id : !isActionCompleteForUser(action, user.id)
      if (!isMine) continue
      if (action.assigned_to && action.completed_at != null) continue // individual, already done

      const overdue = isOverdue(action, trip)
      const days = daysUntilDue(action, trip)
      const dueSoon = days != null && days >= 0 && days * 24 <= 48
      if (overdue || dueSoon) urgentActionCount++
    }
    if (urgentActionCount > 0) {
      items.push({
        icon: '✅',
        label: 'Actions due',
        count: urgentActionCount,
        onClick: () => (onNavigateTab ? onNavigateTab('today') : navigate(`/${tripId}?tab=today`)),
      })
    }

    return items
  }, [tripId, user, trip, participants, sections, votes, expensesData, settlements, actions, navigate, onNavigateTab])
}
