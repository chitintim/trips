import { supabase } from '../../../lib/supabase'

/**
 * SSE client for the trip-chat v2 edge function.
 * Events: {type:'text',text} streamed deltas · {type:'proposal',proposal_id}
 * when the AI stages a changeset into ai_proposals · {type:'done',message,
 * actions_summary,proposal_id?} · {type:'error',error}.
 */
export interface ChatStreamCallbacks {
  onText: (delta: string) => void
  /** The AI staged a proposal — refetch ai_proposals and render review cards. */
  onProposal: (proposalId: string) => void
  onDone: (fullMessage: string) => void
  onError: (error: string) => void
}

/**
 * Shared copy for the 429 rate-limit case -- every ChatQuotaError consumer
 * (ChatSheet's notice banner, RetrospectivePanel's recap note, ...) should
 * render this exact string rather than inventing its own variant.
 */
export const CHAT_QUOTA_MESSAGE = 'Daily AI quota reached — the assistant will be back tomorrow.'

/** Thrown for the 429 rate-limit envelope (daily AI quota spent). */
export class ChatQuotaError extends Error {
  constructor(message = CHAT_QUOTA_MESSAGE) {
    super(message)
    this.name = 'ChatQuotaError'
  }
}

export async function streamChatMessage(
  tripId: string,
  message: string,
  callbacks: ChatStreamCallbacks
): Promise<void> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')

  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/trip-chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tripId, message }),
  })

  if (response.status === 429) throw new ChatQuotaError()
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error || `Chat request failed (HTTP ${response.status})`)
  }

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sawDone = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (!data) continue
      try {
        const event = JSON.parse(data) as {
          type: string
          text?: string
          proposal_id?: string
          message?: string
          error?: string
        }
        if (event.type === 'text' && event.text) {
          callbacks.onText(event.text)
        } else if (event.type === 'proposal' && event.proposal_id) {
          callbacks.onProposal(event.proposal_id)
        } else if (event.type === 'done') {
          sawDone = true
          callbacks.onDone(event.message ?? '')
        } else if (event.type === 'error') {
          callbacks.onError(event.error ?? 'Something went wrong')
        }
      } catch {
        // Skip unparseable SSE lines.
      }
    }
  }

  if (!sawDone) {
    // Stream ended without a terminal event (network blip) — surface it so
    // the UI can stop its "thinking" state.
    callbacks.onError('The response was cut off — try again.')
  }
}
