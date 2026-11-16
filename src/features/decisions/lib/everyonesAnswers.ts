/**
 * Pure model behind "See everyone's answers" in the Manage sheet: who
 * answered what and who has not, for group choices (votes / ranks / "No
 * preference") and own choices (selections with variant, quantity, dates and
 * the consolidated per-item totals the old order view gave). Uses the one
 * answers engine, so the counts match the card and the to-dos.
 */
import { answersFor, isAnswerer, isOwnChoice, passKindFor, type AnswerPass, type AnswerVote } from '../../../lib/answers/answers'
import type { Json } from '../../../types/database.types'
import { buildOrderLine, readOptionPricing, readOrderItemMetadata, sumOrderLinesByCurrency, type OrderLine } from './decisionShapes'
import { formatMoney } from '../../../lib/money'
import { PASS_LABEL } from './answerCopy'

export interface EAOption {
  id: string
  title: string
  status?: string | null
  currency?: string | null
  metadata?: Json | null
  selections?: ReadonlyArray<{ user_id: string; metadata?: Json | null }> | null
}

export interface EASection {
  id: string
  title: string
  status?: string | null
  metadata?: Json | null
  voting_method?: string | null
  options: ReadonlyArray<EAOption>
}

export interface EAParticipant {
  user_id: string
  active?: boolean | null
  confirmation_status?: string | null
  user?: { full_name?: string | null; email?: string | null } | null
}

export type PersonState = 'answered' | 'passed' | 'waiting'

export interface PersonAnswerRow {
  userId: string
  name: string
  state: PersonState
  /** Options chosen, in rank order for ranked questions. */
  optionIds: string[]
  /** option id -> rank (ranked group choices only). */
  ranks: Record<string, number>
  /** "No preference" / "None for me" when passed. */
  passLabel: string | null
  /** Own choices: the order lines. */
  lines: OrderLine[]
}

export interface OptionAnswerSummary {
  optionId: string
  title: string
  cancelled: boolean
  /** People who picked it. */
  count: number
  userIds: string[]
}

export interface ItemTotal {
  optionId: string
  title: string
  count: number
  quantity: number
  total: number
  currency: string
  /** False when no line of this item has a price: show no amount, never £0. */
  priced: boolean
}

export interface EveryonesAnswers {
  shape: 'group' | 'own'
  ranked: boolean
  people: PersonAnswerRow[]
  perOption: OptionAnswerSummary[]
  answeredCount: number
  passedCount: number
  waiting: PersonAnswerRow[]
  /** Own choices only. */
  itemTotals: ItemTotal[]
  groupTotals: Record<string, number>
}

export function participantName(p: EAParticipant | undefined, fallback = 'Someone'): string {
  return p?.user?.full_name || p?.user?.email || fallback
}

export function buildEveryonesAnswers(input: {
  section: EASection
  votes: ReadonlyArray<AnswerVote>
  passes?: ReadonlyArray<AnswerPass>
  participants: ReadonlyArray<EAParticipant>
  fallbackCurrency: string
}): EveryonesAnswers {
  const { section, votes, passes, participants, fallbackCurrency } = input
  const own = isOwnChoice(section)
  const ranked = !own && section.voting_method === 'ranked'
  const answers = answersFor(section, { votes, passes })
  const asked = participants.filter(isAnswerer)

  const optionById = new Map(section.options.map((o) => [o.id, o]))
  const passText = PASS_LABEL[passKindFor(section)]

  const people: PersonAnswerRow[] = asked.map((p) => {
    const a = answers.get(p.user_id)
    const name = participantName(p)
    if (!a || (a.optionIds.size === 0 && !a.passed)) {
      return { userId: p.user_id, name, state: 'waiting', optionIds: [], ranks: {}, passLabel: null, lines: [] }
    }
    if (a.optionIds.size === 0 && a.passed) {
      return { userId: p.user_id, name, state: 'passed', optionIds: [], ranks: {}, passLabel: passText, lines: [] }
    }
    const ids = [...a.optionIds]
    if (ranked) ids.sort((x, y) => (a.ranks.get(x) ?? 99) - (a.ranks.get(y) ?? 99))
    const lines: OrderLine[] = own
      ? ids.flatMap((id) => {
          const opt = optionById.get(id)
          if (!opt) return []
          const pricing = readOptionPricing(opt.metadata) || {}
          const mine = (opt.selections ?? []).filter((s) => s.user_id === p.user_id)
          const rows = mine.length ? mine : [{ user_id: p.user_id, metadata: null }]
          return rows.map((s) => buildOrderLine({ id: opt.id, title: opt.title, currency: opt.currency ?? null }, pricing, readOrderItemMetadata(s.metadata), fallbackCurrency))
        })
      : []
    return {
      userId: p.user_id,
      name,
      state: 'answered',
      optionIds: ids,
      ranks: Object.fromEntries(a.ranks),
      passLabel: null,
      lines,
    }
  })

  const perOption: OptionAnswerSummary[] = section.options.map((o) => {
    const userIds = people.filter((r) => r.optionIds.includes(o.id)).map((r) => r.userId)
    return { optionId: o.id, title: o.title, cancelled: o.status === 'cancelled', count: userIds.length, userIds }
  })

  const itemTotals: ItemTotal[] = []
  if (own) {
    for (const o of section.options) {
      const lines = people.flatMap((r) => r.lines.filter((l) => l.optionId === o.id))
      if (lines.length === 0) continue
      const totals = sumOrderLinesByCurrency(lines)
      const [currency, total] = Object.entries(totals)[0] ?? [fallbackCurrency, 0]
      itemTotals.push({ optionId: o.id, title: o.title, count: lines.length, quantity: lines.reduce((n, l) => n + (l.quantity || 1), 0), total, currency, priced: total > 0 })
    }
  }
  // Currencies with nothing priced are left out, so an unpriced question has no group total at all.
  const groupTotals: Record<string, number> = own
    ? Object.fromEntries(Object.entries(sumOrderLinesByCurrency(people.flatMap((r) => r.lines))).filter(([, n]) => n > 0))
    : {}

  return {
    shape: own ? 'own' : 'group',
    ranked,
    people,
    perOption,
    answeredCount: people.filter((r) => r.state === 'answered').length,
    passedCount: people.filter((r) => r.state === 'passed').length,
    waiting: people.filter((r) => r.state === 'waiting'),
    itemTotals,
    groupTotals,
  }
}

/** "£12.00" for a priced line, null (show nothing) for an unpriced one. Never "£0". */
export function linePriceText(line: Pick<OrderLine, 'total' | 'currency'>): string | null {
  return line.total > 0 ? formatMoney(line.total, line.currency) : null
}

/** "£120.00" / "£120.00 + €40.00", or null when nothing is priced (omit the Group total row). */
export function groupTotalText(groupTotals: Record<string, number>): string | null {
  const parts = Object.entries(groupTotals)
    .filter(([, n]) => n > 0)
    .map(([c, n]) => formatMoney(n, c))
  return parts.length ? parts.join(' + ') : null
}

function lineText(line: OrderLine): string {
  const parts = [line.optionTitle]
  if (line.variant) parts.push(`(${line.variant})`)
  if (line.quantity > 1) parts.push(`x${line.quantity}`)
  const dates = line.startDate && line.endDate && line.startDate !== line.endDate ? `${line.startDate} - ${line.endDate}` : line.startDate ?? ''
  const suffix = [dates, linePriceText(line)].filter(Boolean).join(' - ')
  return `${parts.join(' ')}${suffix ? ` - ${suffix}` : ''}`
}

/** Plain text to paste to a supplier or the group chat (own choices). */
export function buildAnswersText(title: string, data: EveryonesAnswers): string {
  const out: string[] = [`${title} - answers`, '']
  for (const p of data.people) {
    if (p.state === 'waiting') continue
    out.push(`${p.name}:`)
    if (p.state === 'passed') out.push(`  ${p.passLabel}`)
    for (const l of p.lines) out.push(`  ${lineText(l)}`)
    out.push('')
  }
  if (data.itemTotals.length) {
    out.push('Per item:')
    for (const t of data.itemTotals) out.push(`  ${t.title}: ${t.count} ${t.count === 1 ? 'answer' : 'answers'} ${t.priced ? `- ${formatMoney(t.total, t.currency)} total` : '- No price set'}`)
    out.push('')
  }
  const total = groupTotalText(data.groupTotals)
  if (total) out.push(`Group total: ${total}`)
  if (data.waiting.length) out.push('', `Not answered yet: ${data.waiting.map((w) => w.name).join(', ')}`)
  return out.join('\n')
}
