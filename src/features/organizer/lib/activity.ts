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
  | 'participant_joined'

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
  participant_joined: { icon: '🎉', phrase: (e) => `joined the trip${e ? ` as ${e}` : ''}` },
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
