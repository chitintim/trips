import { useCallback } from 'react'
import { useAuth } from '../../../hooks/useAuth'
import { useLogActivity, type ActivityFeedEntry } from '../../../lib/queries/useActivityFeed'
import type { Json } from '../../../types/database.types'

/**
 * Typed activity verbs (plan §14: activity_feed written by mutations).
 *
 * Wiring status:
 *  - Everything built by workstream G (organizer console, chat proposal
 *    apply, checklists, bookings) calls useTripActivityLog directly.
 *  - Call sites inside COMPLETED features are the coordinator's to wire
 *    (this workstream must not edit them). Suggested wiring:
 *      rsvp_changed          -> useUpdateConfirmationStatus (useConfirmations.ts)
 *      vote_cast             -> useToggleVote (usePlanning.ts)
 *      poll_closed           -> the decisions feature's auto/manual close path
 *      expense_added         -> QuickCaptureSheet / ExpenseEditorWizard submit
 *      settlement_confirmed  -> useUpdateSettlementStatus (status -> 'confirmed')
 *      option_added          -> useCreateOption / PasteALinkSheet
 *      participant_joined    -> useAddParticipant
 */
export type ActivityVerb =
  | 'rsvp_changed'
  | 'vote_cast'
  | 'poll_closed'
  | 'option_added'
  | 'expense_added'
  | 'settlement_confirmed'
  | 'booking_added'
  | 'booking_updated'
  | 'event_added'
  | 'event_updated'
  | 'proposal_applied'
  | 'checklist_added'
  | 'checklist_completed'
  | 'nudge_drafted'
  | 'chase_settings_updated'
  | 'status_changed'
  | 'participant_joined'
  | 'milestone_materialized'
  | 'proposal_auto_applied'

export interface ActivityEntity {
  type: string
  id?: string
  /** Human-readable label of the entity ("Kumo dinner", "Chalet booking"). */
  label?: string
}

export interface LogActivityInput {
  verb: ActivityVerb
  entity?: ActivityEntity
  metadata?: Record<string, Json | undefined>
}

/**
 * Thin typed wrapper over useLogActivity: stamps the current user as actor
 * and enforces the ActivityVerb union. Fire-and-forget — activity logging
 * must never block or fail the primary mutation, so errors are swallowed.
 */
export function useTripActivityLog(tripId: string) {
  const { user } = useAuth()
  const logActivity = useLogActivity(tripId)

  return useCallback(
    (input: LogActivityInput) => {
      logActivity.mutate(
        {
          actor: user?.id ?? null,
          verb: input.verb,
          entity: (input.entity as unknown as Json) ?? null,
          metadata: (input.metadata as unknown as Json) ?? null,
        },
        { onError: () => undefined }
      )
    },
    // logActivity from useMutation is stable enough for this use; user?.id keys identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tripId, user?.id]
  )
}

// ---------------------------------------------------------------------------
// Human-readable rendering (activity feed panel)
// ---------------------------------------------------------------------------

interface VerbTemplate {
  icon: string
  /** (entityLabel) => phrase after the actor's name. */
  phrase: (entityLabel: string | null) => string
}

const VERB_TEMPLATES: Record<ActivityVerb, VerbTemplate> = {
  rsvp_changed: { icon: '📝', phrase: (e) => `updated their RSVP${e ? ` to ${e}` : ''}` },
  vote_cast: { icon: '🗳️', phrase: (e) => `voted${e ? ` on "${e}"` : ''}` },
  poll_closed: { icon: '🏁', phrase: (e) => `closed the poll${e ? ` "${e}"` : ''}` },
  option_added: { icon: '💡', phrase: (e) => `added the option${e ? ` "${e}"` : ''}` },
  expense_added: { icon: '💰', phrase: (e) => `added the expense${e ? ` "${e}"` : ''}` },
  settlement_confirmed: { icon: '🤝', phrase: (e) => `confirmed a settlement${e ? ` (${e})` : ''}` },
  booking_added: { icon: '🧾', phrase: (e) => `tracked the booking${e ? ` "${e}"` : ''}` },
  booking_updated: { icon: '🧾', phrase: (e) => `updated the booking${e ? ` "${e}"` : ''}` },
  event_added: { icon: '📅', phrase: (e) => `added${e ? ` "${e}"` : ' an event'} to the itinerary` },
  event_updated: { icon: '📅', phrase: (e) => `updated the event${e ? ` "${e}"` : ''}` },
  proposal_applied: { icon: '✨', phrase: (e) => `approved AI-proposed changes${e ? ` (${e})` : ''}` },
  checklist_added: { icon: '📋', phrase: (e) => `added${e ? ` "${e}"` : ' an item'} to the checklist` },
  checklist_completed: { icon: '✅', phrase: (e) => `ticked off${e ? ` "${e}"` : ' a checklist item'}` },
  nudge_drafted: { icon: '👋', phrase: (e) => `nudged${e ? ` ${e}` : ' someone'}` },
  chase_settings_updated: { icon: '⚙️', phrase: () => 'updated auto-chase settings' },
  status_changed: { icon: '🚦', phrase: (e) => `moved the trip${e ? ` to "${e}"` : ' forward'}` },
  participant_joined: { icon: '🎉', phrase: (e) => `joined the trip${e ? ` as ${e}` : ''}` },
  milestone_materialized: { icon: '📌', phrase: (e) => `made${e ? ` "${e}"` : ' a date-derived milestone'} a real event` },
  proposal_auto_applied: { icon: '⚡', phrase: (e) => `auto-applied${e ? ` "${e}"` : ' an AI suggestion'} from their own upload` },
}

export interface RenderedActivity {
  icon: string
  /** Full sentence, e.g. `Alex added the expense "Ramen dinner"`. */
  text: string
  actorName: string
}

/**
 * Render one activity_feed row into a human-readable line. Unknown verbs
 * (e.g. rows written by newer code) degrade to `<actor> <verb>`.
 */
export function renderActivity(entry: ActivityFeedEntry, actorName: string): RenderedActivity {
  const entity = (entry.entity ?? null) as ActivityEntity | null
  const label = entity?.label ?? null
  const template = VERB_TEMPLATES[entry.verb as ActivityVerb]
  if (!template) {
    return { icon: '•', text: `${actorName} ${entry.verb.replace(/_/g, ' ')}`, actorName }
  }
  return { icon: template.icon, text: `${actorName} ${template.phrase(label)}`, actorName }
}

// ---------------------------------------------------------------------------
// Notification kind vocabulary (organizer "Emails" panel — human-readable
// labels for `notifications.kind`, the sent/skipped chase log written by
// the auto-chase edge function). A different table/shape than activity_feed
// above (no actor, recipient-centric instead), but the same "human-readable
// vocabulary" concern, so it lives alongside VERB_TEMPLATES rather than in
// a separate file.
// ---------------------------------------------------------------------------

export interface NotificationKindInfo {
  icon: string
  /** Human-readable label, e.g. "Overdue action". */
  label: string
}

const NOTIFICATION_KIND_LABELS: Record<string, NotificationKindInfo> = {
  action_due_7d: { icon: '📅', label: 'Action due in 7 days' },
  action_due_1d: { icon: '⏰', label: 'Action due tomorrow' },
  overdue_action: { icon: '🚨', label: 'Overdue action' },
  unclaimed_items: { icon: '🧾', label: 'Unclaimed expense items' },
  unfilled_order: { icon: '🎿', label: 'Picks not filled in' },
  unvoted_poll: { icon: '🗳️', label: 'Poll not voted on' },
  pending_rsvp: { icon: '📝', label: 'RSVP reminder' },
  conditional_date_arrived: { icon: '⏳', label: 'Conditional RSVP follow-up' },
  waitlist_offer: { icon: '🎟️', label: 'Waitlist spot offered' },
  unpaid_settlement: { icon: '💸', label: 'Settlement payment reminder' },
  unconfirmed_settlement: { icon: '🤝', label: 'Settlement confirmation reminder' },
  t30_no_transport: { icon: '✈️', label: 'No transport booked yet' },
  t14_missing_arrival: { icon: '🛬', label: 'Missing arrival details' },
  t1_checkin: { icon: '🛫', label: 'Flight check-in reminder' },
}

/**
 * Human-readable label for a `notifications.kind` value. Unknown kinds
 * (e.g. a new kind a future auto-chase change starts writing) degrade to a
 * humanized version of the raw string rather than disappearing silently.
 */
export function describeNotificationKind(kind: string): NotificationKindInfo {
  return NOTIFICATION_KIND_LABELS[kind] ?? { icon: '✉️', label: kind.replace(/_/g, ' ') }
}
