/**
 * Shared error envelope for all edge functions (plan §13 `_shared/` toolkit).
 * Keeps the existing frontend-visible shape ({ success: false, error }) so
 * old callers (still hitting parse-receipt/trip-chat v1 until cutover) keep
 * working, while giving new functions a single place to format errors.
 */
import { corsHeaders } from './cors.ts'

export class HttpError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/** 401 for missing/invalid auth. */
export class UnauthorizedError extends HttpError {
  constructor(message = 'Unauthorized') {
    super(message, 401)
  }
}

/** 403 for authenticated-but-not-allowed (e.g. not a trip participant). */
export class ForbiddenError extends HttpError {
  constructor(message = 'Forbidden') {
    super(message, 403)
  }
}

/** 429 for rate-limit exhaustion. */
export class RateLimitedError extends HttpError {
  constructor(message = 'Rate limit exceeded. Try again later.') {
    super(message, 429)
  }
}

/** 422 for validation failures against a Zod contract. */
export class ValidationError extends HttpError {
  constructor(message: string) {
    super(message, 422)
  }
}

export function errorResponse(error: unknown): Response {
  const status = error instanceof HttpError ? error.status : 400
  const message = error instanceof Error ? error.message : 'Request failed'
  console.error('[error]', status, message)
  return new Response(
    JSON.stringify({ success: false, error: message }),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
