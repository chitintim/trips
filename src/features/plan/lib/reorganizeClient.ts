import { supabase } from '../../../lib/supabase'

/** Thrown when the reorganize-plan function returns the 429 rate-limit envelope (5/day/user — a much heavier call than ingest/chat). */
export class ReorganizeQuotaError extends Error {
  constructor(message = "You've reached today's reorganize limit (5/day) — try again tomorrow.") {
    super(message)
    this.name = 'ReorganizeQuotaError'
  }
}

export interface ReorganizePlanRequest {
  trip_id: string
  instructions?: string
  context_text?: string
}

export interface ReorganizePlanResponse {
  success: boolean
  /** ai_proposals row ids just inserted (pending review) — empty when the AI found nothing worth changing. */
  proposal_ids: string[]
  /** e.g. "12 suggested changes across 2 proposals (3 new questions, 5 option updates)". */
  summary: string
}

/**
 * Calls the reorganize-plan edge function (UPGRADE_MASTER_PLAN.md §13 build
 * brief). Raw `fetch` rather than `supabase.functions.invoke` so the 429
 * rate-limit envelope's status code is directly readable — same pattern as
 * nudgeClient.ts's requestNudgeDraft.
 */
export async function requestReorganizePlan(request: ReorganizePlanRequest): Promise<ReorganizePlanResponse> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')

  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/reorganize-plan`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  })

  if (response.status === 429) throw new ReorganizeQuotaError()
  const body = await response.json().catch(() => null)
  if (!response.ok || !(body as { success?: boolean } | null)?.success) {
    throw new Error((body as { error?: string } | null)?.error || `Reorganize failed (HTTP ${response.status})`)
  }
  return body as ReorganizePlanResponse
}
