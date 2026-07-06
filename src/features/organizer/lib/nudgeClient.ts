import { supabase } from '../../../lib/supabase'
import type { NudgeDraftRequest, NudgeDraftResponse } from '../../../shared/contracts/nudgeDraft'

/** Thrown when the nudge-draft function returns the 429 rate-limit envelope. */
export class NudgeQuotaError extends Error {
  constructor(message = 'Daily AI quota reached — try again tomorrow, or write the nudge yourself below.') {
    super(message)
    this.name = 'NudgeQuotaError'
  }
}

/**
 * Call the nudge-draft edge function: AI-drafted, WhatsApp-ready copy for
 * one blocker/person, with a deterministic deep link. Non-streaming JSON.
 */
export async function requestNudgeDraft(request: NudgeDraftRequest): Promise<NudgeDraftResponse> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')

  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/nudge-draft`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  })

  if (response.status === 429) throw new NudgeQuotaError()
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error((body as { error?: string } | null)?.error || `Nudge draft failed (HTTP ${response.status})`)
  }
  return body as NudgeDraftResponse
}
