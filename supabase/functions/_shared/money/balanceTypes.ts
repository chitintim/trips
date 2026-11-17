/**
 * Edge-only structural stand-ins for the frontend row types balances.ts reads
 * (src/lib/queries/useExpenses ExpenseWithDetails, useSettlements Settlement /
 * SettlementCarryover). Structural on purpose: the Supabase rows fit as they
 * come back, with no generated database types in Deno.
 */

export interface ExpenseLineItem {
  id: string
  expense_id: string
  line_number: number
  name_original: string
  name_english: string | null
  quantity: number
  unit_price: number
  subtotal: number
  total_amount: number
  shared_by_all?: boolean | null
}

export interface ExpenseItemClaim {
  id?: string
  expense_id: string
  line_item_id: string
  user_id: string
  quantity_claimed: number
  amount_owed: number
  source?: string | null
  created_by?: string | null
  leftover_quantity?: number | null
  leftover_amount?: number | null
  user?: { id?: string; full_name?: string | null } | null
}

export interface ExpenseSplitRow {
  user_id: string
  amount: number
  base_currency_amount?: number | null
  split_type?: string | null
  user?: { id?: string; full_name?: string | null } | null
}

export interface ExpenseAllocationLink {
  code: string
  expense_id?: string
  expires_at?: string | null
}

export interface ExpenseWithDetails {
  id: string
  trip_id?: string
  description: string
  amount: number
  currency: string
  fx_rate: number | null
  base_currency_amount?: number | null
  category?: string | null
  paid_by: string
  payment_date: string
  created_at?: string | null
  ai_parsed: boolean | null
  status: string | null
  option_id?: string | null
  participant_ids?: string[] | null
  vendor_name?: string | null
  subtotal?: number | null
  tax_amount?: number | null
  service_charge_amount?: number | null
  tip_amount?: number | null
  discount_amount?: number | null
  claim_deadline?: string | null
  claims_sent_at?: string | null
  claims_closed_at?: string | null
  splits: ExpenseSplitRow[]
  line_items: ExpenseLineItem[]
  claims: ExpenseItemClaim[]
  allocation_link: ExpenseAllocationLink | null
  expected_participants?: string[]
}

export interface Settlement {
  id: string
  trip_id: string
  from_user_id: string
  to_user_id: string
  amount: number
  currency: string | null
  status: string
  created_by: string
  settled_at: string
  created_at: string | null
  notes: string | null
  payment_method: string | null
  receipt_disputed_at?: string | null
  last_retracted_at?: string | null
}

export interface SettlementCarryover {
  id: string
  trip_id: string
  from_user_id: string
  to_user_id: string
  amount: number
  currency: string
  created_by: string
  created_at: string
  source_trip_id: string
}
