import { supabase } from './supabase'

export interface ParsedReceiptData {
  vendor_name: string
  vendor_location?: string
  receipt_date?: string
  currency: string
  expense_category: string // 'accommodation' | 'transport' | 'food' | 'activities' | 'equipment' | 'other'
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
}

/**
 * Parse a receipt using the GPT-5-mini Edge Function
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
