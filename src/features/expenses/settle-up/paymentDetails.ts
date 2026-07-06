/**
 * Typed shape for users.payment_details (Json|null in the DB -- no
 * generated type beyond Json, so this feature defines its own contract).
 * Free-form "rails" a user can list (bank/PayNow/Revolut/Wise handle, or
 * free text), shown on the recipient payment-details card (plan §12).
 */
export interface PaymentRail {
  label: string // e.g. "Revolut", "PayNow", "Bank transfer"
  value: string // e.g. "@timlam" or an account number/IBAN
}

export interface PaymentDetails {
  rails: PaymentRail[]
  notes?: string
}

export function parsePaymentDetails(raw: unknown): PaymentDetails {
  if (!raw || typeof raw !== 'object') return { rails: [] }
  const obj = raw as Partial<PaymentDetails>
  return { rails: Array.isArray(obj.rails) ? obj.rails : [], notes: typeof obj.notes === 'string' ? obj.notes : undefined }
}

export function formatPaymentDetailsForCopy(details: PaymentDetails): string {
  const lines = details.rails.map((r) => `${r.label}: ${r.value}`)
  if (details.notes) lines.push(details.notes)
  return lines.join('\n')
}
