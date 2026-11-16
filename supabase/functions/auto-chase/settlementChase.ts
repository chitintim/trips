// Which daily reminder (if any) a payment row earns. Pure, so the rules are pinned by tests.
//
//  - 'suggested'   -> the PAYER is chased to pay (`unpaid_settlement`).
//  - 'marked_paid' -> the RECEIVER is chased to confirm (`unconfirmed_settlement`), EXCEPT once they have already
//    answered "it hasn't arrived" (`receipt_disputed_at` set): then nobody is chased by this job. The payer's
//    "respond" to-do is an in-app item (kind `respond_payment`) and is deliberately NOT an email kind: the job only
//    chases the kinds in CHASE_KINDS, so the dispute emails nobody new.
//  - anything else (confirmed) -> nobody.
export interface ChaseSettlementRow {
  id: string
  from_user_id: string
  to_user_id: string
  status: string
  receipt_disputed_at?: string | null
}

export type SettlementChaseKind = 'unpaid_settlement' | 'unconfirmed_settlement'

export function settlementChase(s: ChaseSettlementRow): { kind: SettlementChaseKind; userId: string } | null {
  if (s.status === 'suggested') return { kind: 'unpaid_settlement', userId: s.from_user_id }
  if (s.status === 'marked_paid') {
    if (s.receipt_disputed_at) return null
    return { kind: 'unconfirmed_settlement', userId: s.to_user_id }
  }
  return null
}
