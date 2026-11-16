import { describe, it, expect } from 'vitest'
import { buildSettlementSummaryCsv } from './csvExport'
import type { Settlement } from '../../../lib/queries/useSettlements'

const st = (id: string, from: string, to: string, notes: string): Settlement =>
  ({ id, from_user_id: from, to_user_id: to, amount: 5, currency: 'GBP', status: 'confirmed', settled_at: null, notes }) as unknown as Settlement

describe('settlement CSV memos', () => {
  const rows = [st('1', 'a', 'b', 'refund due'), st('2', 'c', 'd', 'private')]
  it('keeps memos only where the viewer may see them', () => {
    const csv = buildSettlementSummaryCsv(rows, (id) => id, (s) => s.from_user_id === 'a' || s.to_user_id === 'a')
    expect(csv).toContain('refund due')
    expect(csv).not.toContain('private')
  })
  it('includes everything by default', () => {
    expect(buildSettlementSummaryCsv(rows, (id) => id)).toContain('private')
  })
})
