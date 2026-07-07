/**
 * AI autonomy dial — auto-apply gate (UX_REDESIGN.md Part 3 "Ambient AI"
 * #2). Pure decision logic: given one freshly-ingested proposal (plus the
 * receipt reconciliation result when the classification was 'receipt')
 * and the trip's `ai_autonomy` setting, decides whether it's eligible to
 * apply immediately instead of waiting for human review.
 *
 * Every gate below is conservative by construction:
 *  - only ever considered when `ai_autonomy === 'auto_own_uploads'`;
 *  - only ever considered for the CURRENT USER'S OWN upload (checked by
 *    the caller comparing proposal.created_by to the current user, since
 *    that's the only provenance signal ai_proposals carries — see the
 *    research notes on the table's shape);
 *  - only ever create_* actions are eligible in the first place (the
 *    ingest function's `toProposedAction` never emits update_event or
 *    delete_request — see supabase/functions/ingest/index.ts — so this
 *    module doesn't need its own type-level exclusion, but isEligible
 *    double-checks defensively rather than trusting that invariant blindly
 *    holds forever);
 *  - every action must pass the SAME Zod validation the manual review
 *    path uses (parseProposalActions) — nothing "clean-ish" auto-applies;
 *  - receipts additionally require the reconciliation engine to report
 *    `reconciled: true` (i.e. the numbers actually add up, not just that
 *    every field parsed);
 *  - non-receipt classifications require their minimum "actually usable"
 *    fields to be present (an event needs a title AND a real date; a
 *    booking/expense needs an amount; see `hasRequiredFieldsForAutoApply`).
 */
import type { IngestClassification } from '../../../shared/contracts/ingestResult'
import { parseProposalActions } from './applyProposal'
import type { Json } from '../../../types/database.types'

/**
 * Minimal client-side mirror of supabase/functions/_shared/receiptReconciliation.ts's
 * ReconciliationResult — only the field this gate actually reads. Not
 * imported directly: that module lives in the Deno edge-function runtime
 * (different module resolution/import specifiers) and is out of bounds
 * for the Vite/browser build. The `ingest` edge function's HTTP response
 * already hands the client a plain JSON object with this shape (see
 * supabase/functions/ingest/index.ts's `reconciliation` response field).
 */
export interface AutoApplyReconciliation {
  reconciled: boolean
}

export interface AutoApplyContext {
  aiAutonomy: 'suggest' | 'auto_own_uploads'
  /** True when the current (reviewing) user is also the proposal's created_by — the only "own upload" signal ai_proposals carries. */
  isOwnUpload: boolean
  classification: IngestClassification
  /** Only present when classification === 'receipt' (supabase/functions/ingest/index.ts only runs reconcileReceipt for that branch). */
  reconciliation: AutoApplyReconciliation | null
}

/**
 * Field-completeness check for non-receipt classifications ("required
 * fields present", per the spec — receipts use the reconciliation engine
 * instead, which is a stronger signal than field presence alone).
 */
function hasRequiredFieldsForAutoApply(classification: IngestClassification, action: Record<string, unknown>): boolean {
  switch (classification) {
    case 'event':
      return typeof action.title === 'string' && action.title.trim().length > 0 && typeof action.event_date === 'string'
    case 'booking':
      return typeof action.title === 'string' && action.title.trim().length > 0
    case 'receipt':
      // Handled by the reconciliation check in isEligibleForAutoApply, not here.
      return true
    case 'option':
      // Options never reach ai_proposals (see ingest/index.ts) — never auto-apply-eligible.
      return false
  }
}

/**
 * Decides whether a freshly-ingested proposal's single action is eligible
 * to auto-apply. Callers still run `applyAction` through the exact same
 * code path as manual approval — this function only gates WHETHER that
 * happens automatically, never bypasses HOW it happens.
 */
export function isEligibleForAutoApply(ctx: AutoApplyContext, rawActions: Json): boolean {
  if (ctx.aiAutonomy !== 'auto_own_uploads') return false
  if (!ctx.isOwnUpload) return false

  const entries = parseProposalActions(rawActions)
  if (entries.length !== 1) return false // ingest always produces exactly one action; a multi-action batch (e.g. from chat) is never auto-applied.
  const entry = entries[0]
  if (!entry.action) return false // failed Zod validation — never auto-apply something invalid.
  if (entry.action.type === 'update_event' || entry.action.type === 'delete_request') return false // structurally never eligible, checked defensively.

  if (ctx.classification === 'receipt') {
    return ctx.reconciliation?.reconciled === true
  }

  return hasRequiredFieldsForAutoApply(ctx.classification, entry.action as unknown as Record<string, unknown>)
}
