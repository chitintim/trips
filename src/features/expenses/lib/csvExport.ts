/**
 * Client-side CSV export (plan §12): full expense ledger + settlement
 * summary, generated entirely in the browser as a Blob (no server round
 * trip, no new dependency -- plain string building + escaping).
 */
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Settlement } from '../../../lib/queries/useSettlements'
import { isItemizedExpense } from '../types'

function csvEscape(value: string | number | null | undefined): string {
  const s = value == null ? '' : String(value)
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function toRow(values: Array<string | number | null | undefined>): string {
  return values.map(csvEscape).join(',')
}

export interface CsvUserLookup {
  (userId: string): string
}

/** Builds the full expense ledger CSV: one row per expense, splits summarized inline. */
export function buildExpenseLedgerCsv(expenses: ExpenseWithDetails[], userName: CsvUserLookup): string {
  const header = toRow([
    'Date',
    'Vendor',
    'Description',
    'Category',
    'Paid by',
    'Amount',
    'Currency',
    'Base amount',
    'Base currency component',
    'Split type',
    'Itemized',
    'Splits (name:amount)',
  ])

  const rows = expenses.map((e) => {
    const itemized = isItemizedExpense(e)
    const splitsSummary = itemized
      ? e.claims.map((c) => `${userName(c.user_id)}:${c.amount_owed}`).join('; ')
      : e.splits.map((s) => `${userName(s.user_id)}:${s.amount}`).join('; ')
    const splitType = itemized ? 'itemized' : e.splits[0]?.split_type ?? 'equal'

    return toRow([
      e.payment_date,
      e.vendor_name ?? '',
      e.description,
      e.category,
      userName(e.paid_by),
      e.amount,
      e.currency,
      e.base_currency_amount ?? '',
      e.base_currency_amount != null ? '' : '',
      splitType,
      itemized ? 'yes' : 'no',
      splitsSummary,
    ])
  })

  return [header, ...rows].join('\n')
}

/** Builds the settlement summary CSV: one row per settlement payment. */
export function buildSettlementSummaryCsv(settlements: Settlement[], userName: CsvUserLookup): string {
  const header = toRow(['From', 'To', 'Amount', 'Currency', 'Status', 'Settled at', 'Notes'])
  const rows = settlements.map((s) =>
    toRow([userName(s.from_user_id), userName(s.to_user_id), s.amount, s.currency ?? '', s.status, s.settled_at, s.notes ?? ''])
  )
  return [header, ...rows].join('\n')
}

/** Triggers a browser download of the given CSV text as a Blob (no dependency, plain DOM APIs). */
export function downloadCsv(filename: string, csvText: string): void {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
