/**
 * Coded errors for AI-backed edge functions. The client maps `code` to copy
 * and next steps; `message` is plain, user-safe text (also sent as `error`
 * so clients that only read `error` keep working).
 */
import { corsHeaders } from './cors.ts'
import { HttpError } from './errors.ts'

export type AiErrorCode =
  | 'unreadable'
  | 'too_large'
  | 'unsupported_type'
  | 'rate_limited'
  | 'busy'
  | 'refused'
  | 'unknown'

export const AI_ERROR_STATUS: Record<AiErrorCode, number> = {
  unreadable: 422,
  too_large: 413,
  unsupported_type: 415,
  rate_limited: 429,
  busy: 503,
  refused: 422,
  unknown: 502,
}

export const AI_ERROR_MESSAGE: Record<AiErrorCode, string> = {
  unreadable: "We couldn't read this receipt. Try a clearer, flatter photo, or enter it yourself.",
  too_large: 'This file is too large to scan. Try a smaller photo or PDF.',
  unsupported_type: "This file type can't be scanned. Use a JPG, PNG, WebP, GIF or PDF.",
  rate_limited: "You've reached your daily scan limit. Try again tomorrow, or enter it yourself.",
  busy: 'The scanner is busy right now. Please try again in a minute.',
  refused: "The scanner couldn't process this one. Please enter it yourself.",
  unknown: 'Something went wrong while scanning. Please try again.',
}

export class AiCallError extends HttpError {
  code: AiErrorCode
  /** Short internal detail for logs (never prompt/image/response content). */
  detail?: string
  constructor(code: AiErrorCode, detail?: string, message?: string, status?: number) {
    super(message ?? AI_ERROR_MESSAGE[code], status ?? AI_ERROR_STATUS[code])
    this.code = code
    this.detail = detail
  }
}

/** True when the failure is ours/the provider's, not the user's input. */
export function isServerSideAiFailure(code: AiErrorCode): boolean {
  return code === 'busy' || code === 'rate_limited' || code === 'unknown'
}

/** Builds `{ success:false, error, message, code }` with the code's HTTP status. */
export function codedErrorResponse(error: unknown): Response {
  let code: AiErrorCode
  let message: string
  let status: number
  if (error instanceof AiCallError) {
    code = error.code
    message = error.message
    status = error.status
  } else if (error instanceof HttpError) {
    // Non-AI HttpError (auth, forbidden, plain rate limit): keep its status.
    code = error.status === 429 ? 'rate_limited' : 'unknown'
    message = error.message
    status = error.status
  } else {
    code = 'unknown'
    message = AI_ERROR_MESSAGE.unknown
    status = AI_ERROR_STATUS.unknown
  }
  console.error('[ai-error]', status, code, error instanceof AiCallError ? (error.detail ?? '') : '')
  return new Response(JSON.stringify({ success: false, error: message, message, code }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
