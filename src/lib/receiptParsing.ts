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

/**
 * Parse a receipt using Claude Sonnet 4.6 (with OpenAI fallback) Edge Function
 * @param receiptPath - Path to receipt in Supabase Storage (e.g., "userId/filename.jpg")
 * @param tripId - Trip ID for authentication verification
 * @returns Parsed receipt data with vendor, items, totals, etc.
 * @throws Error if parsing fails or user is not authenticated
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
    throw new Error(errorData.error || `Failed to parse receipt (HTTP ${response.status})`)
  }

  const result = await response.json()
  if (!result.success) {
    throw new Error(result.error || 'Receipt parsing failed')
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
