// What the chat client is told when the model stream fails. Never the upstream
// error body or an Error.message (they can echo request content): a coded,
// fixed sentence only.

import { AiCallError, type AiErrorCode } from '../_shared/aiError.ts'

const CHAT_ERROR_TEXT: Record<AiErrorCode, string> = {
  rate_limited: 'The assistant is busy right now. Please try again in a minute.',
  busy: 'The assistant is busy right now. Please try again in a minute.',
  refused: "The assistant couldn't help with that one.",
  too_large: 'That conversation is too long. Start a new chat and try again.',
  unreadable: 'Something went wrong. Please try again.',
  unsupported_type: 'Something went wrong. Please try again.',
  unknown: 'Something went wrong. Please try again.',
}

export function chatStreamErrorPayload(err: unknown): { type: 'error'; error: string; code: AiErrorCode } {
  const code: AiErrorCode = err instanceof AiCallError ? err.code : 'unknown'
  return { type: 'error', error: CHAT_ERROR_TEXT[code], code }
}

/** Safe-to-log summary: class + code only, never message, body or stack. */
export function chatStreamErrorLog(err: unknown): string {
  if (err instanceof AiCallError) return `${err.code} ${err.status}`
  return err instanceof Error ? err.name : 'non-error'
}
