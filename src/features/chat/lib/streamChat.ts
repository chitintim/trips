import { supabase } from '../../../lib/supabase'
import { CHAT_OFF_MESSAGE } from './chatSettings'
import { parseEnvelope, type ChatActionEnvelope } from './payload'

/**
 * SSE client for the trip-chat edge function.
 *
 * Events (additive; an older server only sends text / proposal / done / error and everything still works):
 *   {type:'status', label}            "Checking your to-dos…" before a tool call (fixed server wording, never model text)
 *   {type:'text', text}               streamed text delta
 *   {type:'action', action}           a proposed action (rendered as a card; nothing runs until a tap)
 *   {type:'proposal', proposal_id}    legacy organiser changeset (ai_proposals)
 *   {type:'done', message?, message_id?, actions?}
 *   {type:'error', error}
 * and `: ping` comment lines (keep-alive, ignored).
 */
export interface ChatStreamCallbacks {
  onText: (delta: string) => void
  onStatus?: (label: string) => void
  onAction?: (action: ChatActionEnvelope) => void
  /** The AI staged a legacy proposal: refetch ai_proposals. */
  onProposal: (proposalId: string) => void
  onDone: (fullMessage: string, info?: { messageId: string | null; actionIds: string[]; actionsEnabled: boolean | null }) => void
  onError: (error: string) => void
}

export const CHAT_FALLBACK_ERROR = 'Something went wrong. Please try again.'
export const CHAT_CUT_OFF = 'That answer got cut off — try again.'

/** The server's own words for what went wrong, kept short and plain; anything else becomes a safe sentence. */
export function serverErrorText(raw: unknown): string {
  if (typeof raw !== 'string') return CHAT_FALLBACK_ERROR
  const t = raw.replace(/\s+/g, ' ').trim()
  if (!t || /^(\{|<|\[)/.test(t) || /(^|\s)at\s.+:\d+/.test(t)) return CHAT_FALLBACK_ERROR
  return t.length > 300 ? `${t.slice(0, 297)}...` : t
}

export const CHAT_SPEND_LIMIT_MESSAGE = "You've used today's assistant allowance — it resets within a day."
export const CHAT_DAILY_LIMIT_MESSAGE = "You've reached today's message limit — try again tomorrow."
export const CHAT_QUOTA_MESSAGE = CHAT_DAILY_LIMIT_MESSAGE

/** Thrown for the 429 envelope. `spend_limit` = allowance used up (retrying cannot help); anything else is the daily message limit. */
export class ChatQuotaError extends Error {
  readonly code: 'spend_limit' | 'daily_limit'
  constructor(code: 'spend_limit' | 'daily_limit' = 'daily_limit') {
    super(code === 'spend_limit' ? CHAT_SPEND_LIMIT_MESSAGE : CHAT_DAILY_LIMIT_MESSAGE)
    this.name = 'ChatQuotaError'
    this.code = code
  }
}

/** Thrown for the 403 `chat_off` envelope: the assistant is switched off for this trip, so retrying cannot help. */
export class ChatOffError extends Error {
  readonly code = 'chat_off' as const
  constructor() {
    super(CHAT_OFF_MESSAGE)
    this.name = 'ChatOffError'
  }
}

/** The browser's IANA time zone, or undefined when it cannot be read. */
export function browserTimeZone(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof tz === 'string' && tz ? tz : undefined
  } catch {
    return undefined
  }
}

export type StreamEvent =
  | { type: 'status'; label: string }
  | { type: 'text'; text: string }
  | { type: 'action'; action: ChatActionEnvelope }
  | { type: 'proposal'; proposalId: string }
  | { type: 'done'; message: string; messageId: string | null; actionIds: string[]; actionsEnabled: boolean | null }
  | { type: 'error'; error: string }

/** One `data:` payload to an event, or null for anything unknown / malformed (skipped, never fatal). */
export function parseStreamEvent(data: string): StreamEvent | null {
  let e: Record<string, unknown>
  try {
    const v = JSON.parse(data)
    if (!v || typeof v !== 'object') return null
    e = v as Record<string, unknown>
  } catch {
    return null
  }
  switch (e.type) {
    case 'status':
      return typeof e.label === 'string' && e.label.trim() ? { type: 'status', label: e.label.slice(0, 80) } : null
    case 'text':
      return typeof e.text === 'string' && e.text ? { type: 'text', text: e.text } : null
    case 'action': {
      const action = parseEnvelope(e.action)
      return action ? { type: 'action', action } : null
    }
    case 'proposal':
      return typeof e.proposal_id === 'string' ? { type: 'proposal', proposalId: e.proposal_id } : null
    case 'done':
      return {
        type: 'done',
        message: typeof e.message === 'string' ? e.message : '',
        messageId: typeof e.message_id === 'string' ? e.message_id : null,
        actionIds: Array.isArray(e.actions) ? e.actions.filter((x): x is string => typeof x === 'string') : [],
        actionsEnabled: typeof e.actions_enabled === 'boolean' ? e.actions_enabled : null,
      }
    case 'error':
      return { type: 'error', error: typeof e.error === 'string' && e.error ? e.error : 'Something went wrong' }
    default:
      return null
  }
}

/** Incremental SSE line parser: feed it decoded chunks, get the events completed so far. Comment lines (`: ping`) are ignored. */
export function createSseParser(): { push: (chunk: string) => StreamEvent[] } {
  let buffer = ''
  return {
    push(chunk) {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      const out: StreamEvent[] = []
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '')
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data) continue
        const ev = parseStreamEvent(data)
        if (ev) out.push(ev)
      }
      return out
    },
  }
}

export interface StreamOptions {
  /** Client-generated id for this send; a retry reuses it so the server answers from storage instead of running the model again. */
  turnId?: string
  /** The space the person is looking at (today / plan / money / people). */
  page?: string
}

export async function streamChatMessage(tripId: string, message: string, callbacks: ChatStreamCallbacks, options: StreamOptions = {}): Promise<void> {
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
    body: JSON.stringify({ tripId, message, ...(options.turnId ? { turnId: options.turnId } : {}), ...(options.page ? { page: options.page } : {}), ...(browserTimeZone() ? { tz: browserTimeZone() } : {}) }),
  })

  if (response.status === 429) {
    const body = await response.json().catch(() => ({}))
    throw new ChatQuotaError((body as { code?: unknown }).code === 'spend_limit' ? 'spend_limit' : 'daily_limit')
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    if (response.status === 403 && (body as { code?: unknown }).code === 'chat_off') throw new ChatOffError()
    const detail = (body as { error?: unknown }).error
    throw new Error(typeof detail === 'string' && detail.trim() ? serverErrorText(detail) : `Chat request failed (HTTP ${response.status})`)
  }

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const parser = createSseParser()
  let sawDone = false
  let sawError = false
  let full = ''

  const handle = (ev: StreamEvent) => {
    switch (ev.type) {
      case 'text':
        full += ev.text
        callbacks.onText(ev.text)
        break
      case 'status':
        callbacks.onStatus?.(ev.label)
        break
      case 'action':
        callbacks.onAction?.(ev.action)
        break
      case 'proposal':
        callbacks.onProposal(ev.proposalId)
        break
      case 'done':
        sawDone = true
        callbacks.onDone(ev.message || full, { messageId: ev.messageId, actionIds: ev.actionIds, actionsEnabled: ev.actionsEnabled })
        break
      case 'error':
        sawError = true
        callbacks.onError(serverErrorText(ev.error))
        break
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    for (const ev of parser.push(decoder.decode(value, { stream: true }))) handle(ev)
  }
  for (const ev of parser.push('\n')) handle(ev)

  if (!sawDone && !sawError) callbacks.onError(CHAT_CUT_OFF)
}
