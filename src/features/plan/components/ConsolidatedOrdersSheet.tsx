import { useMemo, useState } from 'react'
import { Modal, Button, useToast } from '../../../components/ui'
import { readOptionPricing, readOrderItemMetadata, buildOrderLine, sumOrderLinesByCurrency, type OrderLine } from '../../decisions/lib/decisionShapes'
import { formatMoney } from '../../decisions/lib/costImpact'
import type { SectionWithOptions } from '../../../lib/queries/usePlanning'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'

export interface ConsolidatedOrdersSheetProps {
  isOpen: boolean
  onClose: () => void
  section: SectionWithOptions
  participants: ParticipantWithUser[]
  fallbackCurrency: string
}

interface PersonOrder {
  userId: string
  name: string
  lines: OrderLine[]
}

function userLabel(p: ParticipantWithUser | undefined, userId: string): string {
  return p?.user?.full_name || p?.user?.email || userId
}

function formatDateRange(line: OrderLine): string {
  if (!line.startDate && !line.endDate) return ''
  if (line.startDate === line.endDate || !line.endDate) return line.startDate ?? ''
  return `${line.startDate} – ${line.endDate}`
}

function formatLine(line: OrderLine): string {
  const parts = [line.optionTitle]
  if (line.variant) parts.push(`(${line.variant})`)
  if (line.quantity > 1) parts.push(`x${line.quantity}`)
  const dateRange = formatDateRange(line)
  const suffix = [dateRange, formatMoney(line.total, line.currency)].filter(Boolean).join(' — ')
  return `${parts.join(' ')}${suffix ? ` — ${suffix}` : ''}`
}

function buildOrderSheetText(sectionTitle: string, people: PersonOrder[], itemTotals: Array<{ title: string; count: number; total: number; currency: string }>, groupTotals: Record<string, number>): string {
  const lines: string[] = [`${sectionTitle} — order summary`, '']

  for (const person of people) {
    lines.push(`${person.name}:`)
    for (const line of person.lines) {
      lines.push(`  ${formatLine(line)}`)
    }
    lines.push('')
  }

  lines.push('Per item:')
  for (const item of itemTotals) {
    lines.push(`  ${item.title}: ${item.count} order${item.count === 1 ? '' : 's'} — ${formatMoney(item.total, item.currency)} total`)
  }
  lines.push('')

  const groupTotalStr = Object.entries(groupTotals)
    .map(([currency, amount]) => formatMoney(amount, currency))
    .join(' + ')
  lines.push(`Group total: ${groupTotalStr || formatMoney(0, 'GBP')}`)

  return lines.join('\n')
}

/**
 * Organizer view for a personal-order (shape 2) section (UX_REDESIGN.md
 * Part 5): people × items with dates/variants, per-item totals, group
 * total, and a "Copy order sheet" plain-text summary ready to paste to a
 * vendor or the group chat.
 */
export function ConsolidatedOrdersSheet({ isOpen, onClose, section, participants, fallbackCurrency }: ConsolidatedOrdersSheetProps) {
  const { showToast } = useToast()
  const [copied, setCopied] = useState(false)

  const people = useMemo<PersonOrder[]>(() => {
    const byUser = new Map<string, OrderLine[]>()
    for (const option of section.options) {
      // Legacy pre-v3 options (see 20260707160000_legacy_sections_to_personal)
      // carry no catalog pricing at all — that must not drop the option's
      // selections from the matrix entirely, just leave their line's total
      // at 0 (buildOrderLine already handles a pricing-less spec that way).
      const pricing = readOptionPricing(option.metadata) || {}
      for (const selection of option.selections) {
        const item = readOrderItemMetadata(selection.metadata)
        const line = buildOrderLine({ id: option.id, title: option.title, currency: option.currency }, pricing, item, fallbackCurrency)
        const list = byUser.get(selection.user_id) ?? []
        list.push(line)
        byUser.set(selection.user_id, list)
      }
    }
    return Array.from(byUser.entries()).map(([userId, lines]) => ({
      userId,
      name: userLabel(
        participants.find((p) => p.user_id === userId),
        userId
      ),
      lines,
    }))
  }, [section.options, participants, fallbackCurrency])

  const itemTotals = useMemo(() => {
    return section.options
      .map((option) => {
        const pricing = readOptionPricing(option.metadata) || {}
        const lines = option.selections.map((s) => buildOrderLine({ id: option.id, title: option.title, currency: option.currency }, pricing, readOrderItemMetadata(s.metadata), fallbackCurrency))
        if (lines.length === 0) return null
        const totals = sumOrderLinesByCurrency(lines)
        const [currency, total] = Object.entries(totals)[0]
        return { title: option.title, count: lines.length, total, currency }
      })
      .filter((x): x is { title: string; count: number; total: number; currency: string } => x !== null)
  }, [section.options, fallbackCurrency])

  const groupTotals = useMemo(() => sumOrderLinesByCurrency(people.flatMap((p) => p.lines)), [people])

  const handleCopy = async () => {
    const text = buildOrderSheetText(section.title, people, itemTotals, groupTotals)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      showToast({ type: 'success', message: 'Order sheet copied' })
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      showToast({ type: 'error', message: 'Could not copy to clipboard', description: (err as Error).message })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" title={`${section.title} — orders`}>
      <div className="space-y-4">
        {people.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">Nobody has ordered yet.</p>
        ) : (
          <div className="overflow-x-auto -mx-4 px-4">
            <table className="w-full min-w-[420px] border-collapse text-sm">
              <thead>
                <tr>
                  <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide p-2 bg-[var(--surface-sunken)]">Person</th>
                  {section.options.map((option) => (
                    <th key={option.id} className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide p-2 bg-[var(--surface-sunken)]">
                      {option.title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {people.map((person) => (
                  <tr key={person.userId} className="border-t border-[var(--border-subtle)]">
                    <td className="p-2 font-medium text-[var(--text-primary)]">{person.name}</td>
                    {section.options.map((option) => {
                      const line = person.lines.find((l) => l.optionId === option.id)
                      return (
                        <td key={option.id} className="p-2 text-[var(--text-secondary)]">
                          {line ? (
                            <div className="space-y-0.5">
                              <div>
                                {line.variant ? `${line.variant} ` : ''}
                                {line.quantity > 1 ? `x${line.quantity}` : ''}
                              </div>
                              <div className="text-xs text-[var(--text-muted)]">{formatDateRange(line)}</div>
                              <div className="text-xs font-medium">{formatMoney(line.total, line.currency)}</div>
                            </div>
                          ) : (
                            <span className="text-[var(--text-muted)]">—</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] p-3 space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Per-item totals</p>
          {itemTotals.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">No orders yet.</p>
          ) : (
            itemTotals.map((item) => (
              <div key={item.title} className="flex items-center justify-between text-sm">
                <span className="text-[var(--text-secondary)]">
                  {item.title} ({item.count})
                </span>
                <span className="font-medium text-[var(--text-primary)]">{formatMoney(item.total, item.currency)}</span>
              </div>
            ))
          )}
          <div className="flex items-center justify-between text-sm pt-1.5 border-t border-[var(--border-default)]">
            <span className="font-semibold text-[var(--text-primary)]">Group total</span>
            <span className="font-semibold text-[var(--text-primary)]">
              {Object.entries(groupTotals)
                .map(([currency, amount]) => formatMoney(amount, currency))
                .join(' + ') || formatMoney(0, fallbackCurrency)}
            </span>
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2 border-t border-[var(--border-subtle)]">
          <Button variant="outline" onClick={handleCopy}>
            {copied ? '✓ Copied' : '📋 Copy order sheet'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  )
}
