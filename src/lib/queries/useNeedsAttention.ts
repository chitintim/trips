import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { NeedsAttentionItem } from '../../components/layout'
import { useParticipants } from './useTrip'
import { useSections, useVotes } from './usePlanning'
import { useExpenses } from './useExpenses'
import { useSettlements } from './useSettlements'

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
 */
export function useNeedsAttention(tripId: string | undefined): NeedsAttentionItem[] {
  const { user } = useAuth()
  const navigate = useNavigate()

  const { data: participants } = useParticipants(tripId)
  const { data: sections } = useSections(tripId)
  const { data: votes } = useVotes(tripId)
  const { data: expensesData } = useExpenses(tripId)
  const { data: settlements } = useSettlements(tripId)

  return useMemo(() => {
    if (!tripId || !user) return []

    const items: NeedsAttentionItem[] = []
    const now = Date.now()

    // ---- Pending RSVP ------------------------------------------------
    const myParticipant = participants?.find((p) => p.user_id === user.id)
    if (myParticipant) {
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
          onClick: () => navigate(`/${tripId}?tab=overview`),
        })
      }
    }

    // ---- Open polls not yet voted in ---------------------------------
    const myVotedOptionIds = new Set((votes || []).filter((v) => v.user_id === user.id).map((v) => v.option_id))
    let openPollCount = 0
    for (const section of sections || []) {
      if (!section.vote_deadline) continue
      if (new Date(section.vote_deadline).getTime() <= now) continue
      const hasVoted = (section.options || []).some((o) => myVotedOptionIds.has(o.id))
      if (!hasVoted && (section.options || []).length > 0) openPollCount++
    }
    if (openPollCount > 0) {
      items.push({
        icon: '🗳️',
        label: 'Unvoted polls',
        count: openPollCount,
        onClick: () => navigate(`/${tripId}?tab=planning`),
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
        onClick: () => navigate(`/${tripId}?tab=expenses`),
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
        onClick: () => navigate(`/${tripId}?tab=expenses`),
      })
    }

    return items
  }, [tripId, user, participants, sections, votes, expensesData, settlements, navigate])
}
