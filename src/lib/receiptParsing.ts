import { supabase } from './supabase'
import type { ReceiptParseResult } from '../shared/contracts/receiptParseResult'

/**
 * Minimal client-side mirror of supabase/functions/_shared/receiptReconciliation.ts's
 * ReconciliationResult -- only the fields the UI reads. Not imported
 * directly: that module lives in the Deno edge-function runtime (different
 * module resolution) and is out of bounds for the Vite/browser build (same
 * pattern as src/features/chat/lib/autoApply.ts's AutoApplyReconciliation).
 */
export interface ClientReconciliationResult {
  reconciled: boolean
  explanation: string
}

export interface ParsedReceiptData {
  vendor_name: string
  vendor_location?: string
  receipt_date?: string
  currency: string
  expense_category: string // 'accommodation' | 'transport' | 'food' | 'activities' | 'equipment' | 'other'
  vat_inclusive: boolean
  subtotal: number
  total: number
  tax_percent?: number
  tax_amount?: number
  service_charge_percent?: number
  service_charge_amount?: number
  discount_amount?: number
  discount_percent?: number
  line_items: Array<{
    line_number: number
    name_original: string
    name_english?: string
    quantity: number
    unit_price: number
    line_discount_amount?: number
    line_discount_percent?: number
    subtotal: number
    tax_amount: number
    service_amount: number
    total_amount: number
  }>
  total_matches: boolean
  calculation_notes?: string
  /**
   * v2 addition (parse-receipt rewrite, see supabase/functions/parse-receipt/index.ts
   * `toLegacyShape`): the edge function ALWAYS includes this alongside the
   * legacy flat fields above -- it's the source of truth for itemization
   * (per-line printed_field, discounts, tax/service provenance) that the
   * legacy `line_items` shape above lossily flattens away. Consumers that
   * itemize (quick-capture "refine" -> itemized editor) should prefer this
   * over the legacy `line_items` field.
   */
  v2?: {
    receipt: ReceiptParseResult
    reconciliation: ClientReconciliationResult
  }
}

/** Largest PDF the scanner accepts. Mirrors MAX_PDF_BYTES in supabase/functions/parse-receipt/fileType.ts. */
export const RECEIPT_MAX_PDF_BYTES = 10 * 1024 * 1024
export const RECEIPT_MAX_PDF_MB = RECEIPT_MAX_PDF_BYTES / 1024 / 1024

/** Error codes returned by the parse-receipt edge function (see _shared/aiError.ts). */
export type ReceiptParseErrorCode =
  | 'unreadable'
  | 'too_large'
  | 'unsupported_type'
  | 'rate_limited'
  | 'busy'
  | 'refused'
  | 'unknown'

const RECEIPT_ERROR_COPY: Record<ReceiptParseErrorCode, { message: string; retryable: boolean }> = {
  unreadable: {
    message: "We couldn't read this receipt. Try a clearer, flatter photo, or enter it yourself.",
    retryable: false,
  },
  too_large: {
    message: `This file is too large to scan. Try a smaller photo or a PDF under ${RECEIPT_MAX_PDF_MB} MB.`,
    retryable: false,
  },
  unsupported_type: {
    message: "This file type can't be scanned. Use a JPG, PNG, WebP, GIF or PDF.",
    retryable: false,
  },
  rate_limited: {
    message: "You've reached your daily scan limit. Try again tomorrow, or enter it yourself.",
    retryable: true,
  },
  busy: { message: 'The scanner is busy right now. Please try again in a minute.', retryable: true },
  refused: { message: "The scanner couldn't process this one. Please enter it yourself.", retryable: false },
  unknown: { message: 'Something went wrong while scanning. Please try again.', retryable: true },
}

/**
 * Error thrown by parseReceipt for server-reported failures. Extends Error so
 * existing `instanceof Error` / `.message` callers keep working; `code` is
 * undefined when the (old) server response carried no code.
 */
export class ReceiptParseError extends Error {
  code?: ReceiptParseErrorCode
  status?: number
  retryable: boolean
  constructor(message: string, opts: { code?: ReceiptParseErrorCode; status?: number; retryable?: boolean } = {}) {
    super(message)
    this.name = 'ReceiptParseError'
    this.code = opts.code
    this.status = opts.status
    this.retryable = opts.retryable ?? false
  }
}

/** Builds the error for a failed response body; old shape (no known code) keeps the previous message. */
export function buildReceiptParseError(
  body: { error?: string; code?: unknown } | null | undefined,
  status: number | undefined,
  fallback: string
): ReceiptParseError {
  const code = body?.code
  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(RECEIPT_ERROR_COPY, code)) {
    const c = code as ReceiptParseErrorCode
    // too_large carries a specific, user-safe sentence from the server (photo vs PDF pages); prefer it.
    const message = c === 'too_large' && typeof body?.error === 'string' && body.error ? body.error : RECEIPT_ERROR_COPY[c].message
    return new ReceiptParseError(message, {
      code: c,
      status,
      retryable: RECEIPT_ERROR_COPY[c].retryable,
    })
  }
  return new ReceiptParseError(body?.error || fallback, { status })
}

/**
 * Parse a receipt using the parse-receipt Edge Function (server-side AI scan)
 * @param receiptPath - Path to receipt in Supabase Storage (e.g., "userId/filename.jpg")
 * @param tripId - Trip ID for authentication verification
 * @returns Parsed receipt data with vendor, items, totals, etc.
 * @throws ReceiptParseError (an Error subclass) if parsing fails, or Error if the user is not authenticated
 */
export async function parseReceipt(
  receiptPath: string,
  tripId: string
): Promise<ParsedReceiptData> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    throw new Error('Not authenticated. Please log in.')
  }

  const response = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/parse-receipt`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ receiptPath, tripId }),
    }
  )

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw buildReceiptParseError(errorData, response.status, `Failed to parse receipt (HTTP ${response.status})`)
  }

  const result = await response.json()
  if (!result.success) {
    throw buildReceiptParseError(result, response.status, 'Receipt parsing failed')
  }

  return result.data
}

/**
 * Generate a random 8-character alphanumeric code for allocation links
 * Uses unambiguous characters only (no O/0, I/1, etc.)
 */
export function generateLinkCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // No ambiguous chars
  let code = ''
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}
