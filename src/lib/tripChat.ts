import { supabase } from './supabase'

export interface ChatAction {
  type: 'create_event' | 'update_event' | 'delete_event'
  event_title?: string
  event_date?: string
  category?: string
}

export interface ChatStreamCallbacks {
  onText: (chunk: string) => void
  onDone: (message: string, actions: ChatAction[]) => void
  onError: (error: string) => void
}

/**
 * Send a chat message with streaming response.
 * The edge function returns SSE events:
 *   { type: 'text', text: '...' }     — streamed text chunk
 *   { type: 'done', message, actions_summary } — final result
 *   { type: 'error', error }           — error
 */
export async function sendChatMessage(
  tripId: string,
  message: string,
  callbacks: ChatStreamCallbacks
): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    throw new Error('Not authenticated. Please log in.')
  }

  const response = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/trip-chat`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tripId, message }),
    }
  )

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new Error(errorData.error || `Chat request failed (HTTP ${response.status})`)
  }

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim()
        if (!data) continue

        try {
          const event = JSON.parse(data)
          if (event.type === 'text') {
            callbacks.onText(event.text)
          } else if (event.type === 'done') {
            callbacks.onDone(event.message, event.actions_summary || [])
          } else if (event.type === 'error') {
            callbacks.onError(event.error)
          }
        } catch {
          // Skip unparseable events
        }
      }
    }
  }
}
