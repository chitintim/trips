import type { Json } from '../../../types/database.types'

/**
 * AI autonomy dial (UX_REDESIGN.md Part 3 "Ambient AI" #2): a second key
 * living in the same `trips.chase_settings` jsonb blob as `ChaseSettings`
 * (chaseSettings.ts) and the creation wizard's `dates_pending` (datePoll.ts)
 * — kept in its own small module rather than folded into `ChaseSettings`
 * because it's read/written independently (the ingest apply flow only
 * cares about this one key, not the whole chase config) and because
 * `ChaseSettings` is typed as an exhaustive object today; this follows the
 * same "one function reads its own key defensively, mergeChaseSettingsJson
 * merges everything back together" pattern as dates_pending.
 *
 * 'suggest' (default): every AI-derived change is a proposal a human must
 * approve — the existing ai_proposals pipeline, unchanged.
 * 'auto_own_uploads': create-only actions from the CURRENT USER'S OWN
 * ingest, when validation-clean and high-confidence, apply immediately
 * under their JWT (see src/features/chat/lib/autoApply.ts for the gate).
 * Deletes/updates are never eligible regardless of this setting — that
 * restriction lives structurally in the actions the ingest function can
 * even produce (see applyProposal.ts's DELETE_TABLES / ProposedAction
 * union), not in this dial.
 */
export type AiAutonomy = 'suggest' | 'auto_own_uploads'

export const DEFAULT_AI_AUTONOMY: AiAutonomy = 'suggest'

export function parseAiAutonomy(raw: Json | null | undefined): AiAutonomy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_AI_AUTONOMY
  const value = (raw as Record<string, unknown>).ai_autonomy
  return value === 'auto_own_uploads' ? 'auto_own_uploads' : DEFAULT_AI_AUTONOMY
}
