import { describe, it, expect } from 'vitest'
import { claimAmountMinor } from './claimMath'
import parity from '../lib/ownClaimParityCases.json'

/**
 * The same cases the database runs against `set_my_receipt_claims` (supabase/tests/pglite). The claim page shows these amounts while
 * people tap, and the server then charges its own; both must agree to the penny.
 */
type Case = { name: string; currency: string; line: { quantity: number; total: number }; others: Array<[number, number]>; quantity: number; expectMinor: number }

describe('own-claim amounts: client = server', () => {
  it.each((parity as unknown as { cases: Case[] }).cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const line = { quantity: c.line.quantity, total_amount: c.line.total } as Parameters<typeof claimAmountMinor>[0]
    const others = c.others.map(([quantity_claimed, amount_owed]) => ({ quantity_claimed, amount_owed }))
    expect(claimAmountMinor(line, c.quantity, others, c.currency)).toBe(c.expectMinor)
  })
})
