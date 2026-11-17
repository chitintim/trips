import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, UserAvatar } from '../../../components/ui'
import { formatMoneyMinor } from '../lib/formatMoney'
import { withMoneyParticipants } from '../lib/balances'
import { explainMoneyPosition } from '../../../lib/cost/moneyEquation'
import { buildMoneyPositionView } from './moneyPositionView'
import { computeMoneyPosition, computePairwiseLedger, mergeSettlementsWithUsableCarryovers } from './moneyPosition'
import type { PairwiseLedgerEntry } from './moneyPosition'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Settlement, SettlementCarryover } from '../../../lib/queries/useSettlements'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'

export interface MoneyPositionHeaderProps {
  expenses: ExpenseWithDetails[]
  settlements: Settlement[]
  /** Already-folded cross-trip carryovers for this trip (as fold target) -- folded into the SAME balance math settlements use, so this header agrees with Settle Up. */
  carryovers?: SettlementCarryover[]
  participants: ParticipantWithUser[]
  /** Active + removed participants, used only to NAME people who left but are still in the money. */
  allParticipants?: ParticipantWithUser[]
  currentUserId: string | undefined
  baseCurrency: string
  /** trips.settlement_snapshot is set: balances are frozen and the pay to-dos come from the suggested rows. The headline then never contradicts them. */
  frozen?: boolean
  /** Settle-up STATE card affordance (plan §4 #4) — only meaningful when there's actually something to settle. */
  onSettleUp: () => void
  /** The "recorded twice" hint: open Settle up scrolled to the duplicate-payments notice. */
  onSeeDuplicates?: () => void
  /** "See my breakdown" — pushes My Spending as a screen (plan §4 #5). */
  onSeeMyBreakdown: () => void
}

const TONE_EMOJI = { owed: '💰', owe: '⚠️', waiting: '⏳', settled: '✅' } as const
const TONE_COLOR = {
  owe: 'text-danger-600',
  owed: 'text-success-600',
  waiting: 'text-[var(--text-primary)]',
  settled: 'text-[var(--text-primary)]',
} as const

/** Short human date for a ledger entry line ("1 Jul"). */
function ledgerDateLabel(date: string): string {
  if (!date) return ''
  return new Date(date + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** What a non-expense ledger entry IS, viewer-relative: sign already encodes direction (+ = the current user paid / is owed more). */
function ledgerEntryLabel(entry: PairwiseLedgerEntry, counterpartyName: string): string {
  if (entry.kind === 'carryover') return 'Carried over from another trip'
  return entry.amountMinor >= 0 ? `You paid ${counterpartyName}` : `${counterpartyName} paid you`
}

/**
 * MoneySpace's position header (UX_REDESIGN.md Part 4 "Money: balance-first,
 * no inner tabs" #1): the single most important line on the Money space —
 * "You're owed £84" / "You owe £42 → Settle" / "All square ✓" — with an
 * expandable per-person breakdown and a "see my breakdown" link into My
 * Spending. Each per-person row is itself tappable, unfolding the pairwise
 * ledger (expense shares + P2P payments between the two of you) so anyone
 * can see WHY they owe what they owe mid-trip. Built on the same balance
 * math every other money surface uses.
 */
export function MoneyPositionHeader({
  expenses,
  settlements,
  carryovers = [],
  participants,
  allParticipants = [],
  currentUserId,
  baseCurrency,
  frozen = false,
  onSettleUp,
  onSeeDuplicates,
  onSeeMyBreakdown,
}: MoneyPositionHeaderProps) {
  const [expanded, setExpanded] = useState(false)
  const [expandedPersonId, setExpandedPersonId] = useState<string | null>(null)
  const [showEquation, setShowEquation] = useState(true)
  const position = computeMoneyPosition(
    expenses,
    settlements,
    participants.map((p) => p.user_id),
    currentUserId,
    baseCurrency,
    carryovers
  )
  const byUserId = new Map([...allParticipants, ...participants].map((p) => [p.user_id, p]))
  // The headline and the "how it adds up" rows: same ledger maths as Settle up
  // (explainMoneyPosition wraps computeBalances), plus payments by status.
  const view = useMemo(() => {
    if (!currentUserId) return null
    const names: Record<string, string> = {}
    for (const p of [...allParticipants, ...participants]) names[p.user_id] = p.user?.full_name || p.user?.email || 'someone'
    return buildMoneyPositionView(
      explainMoneyPosition({
        expenses,
        settlements,
        participantUserIds: participants.map((p) => p.user_id),
        currentUserId,
        baseCurrency,
        carryovers,
        frozen,
        names,
      })
    )
  }, [expenses, settlements, carryovers, participants, allParticipants, currentUserId, baseCurrency, frozen])

  // Same merged real-settlements + usable-carryovers list computeMoneyPosition
  // fed computePairwiseBreakdown -- the per-pair ledger must read the same
  // rows or its lines wouldn't sum to the net shown on the row above.
  const settlementsWithCarryovers = useMemo(
    () =>
      mergeSettlementsWithUsableCarryovers(
        settlements,
        carryovers,
        baseCurrency,
        withMoneyParticipants(participants.map((p) => p.user_id), expenses, settlements, baseCurrency, carryovers)
      ),
    [expenses, settlements, carryovers, baseCurrency, participants]
  )

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-4 sm:p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
            {TONE_EMOJI[view?.tone ?? 'settled']} Your position
          </p>
          <p className={`mt-1 text-xl sm:text-2xl font-semibold tabular-nums ${TONE_COLOR[view?.tone ?? 'settled']}`}>
            {view ? view.headline : '—'}
          </p>
          {view?.note && <p className="mt-0.5 text-sm text-[var(--text-secondary)]">{view.note}</p>}
          {view?.settleHint && (
            <a
              href={view.settleHintLink}
              onClick={(e) => {
                e.preventDefault()
                ;(onSeeDuplicates ?? onSettleUp)()
              }}
              className="mt-0.5 block text-sm font-medium text-warning-700 underline"
            >
              {view.settleHint}
            </a>
          )}
          {view?.unclaimedNotice && (
            <div className="mt-1.5 text-sm text-[var(--text-secondary)]" role="status">
              <p>{view.unclaimedNotice.text}</p>
              <ul className="mt-0.5 space-y-0.5">
                {view.unclaimedNotice.receipts.map((r) => (
                  <li key={r.key}>
                    {r.claimCode ? (
                      <Link to={`/claim/${r.claimCode}`} className="font-medium text-accent-700 dark:text-accent-400 underline">
                        {r.label}
                      </Link>
                    ) : (
                      <span className="font-medium">{r.label}</span>
                    )}{' '}
                    <span className="tabular-nums">— {r.amount} not claimed</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex flex-col items-end gap-2 shrink-0">
          {!(view?.square ?? position.kind === 'settled') && (
            <Button variant="primary" size="sm" onClick={onSettleUp}>
              Settle
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onSeeMyBreakdown}>
            See my breakdown →
          </Button>
        </div>
      </div>

      {position.expensesMissingRate.length > 0 && (
        <Badge variant="warning">
          ⚠️ {position.expensesMissingRate.length} expense{position.expensesMissingRate.length === 1 ? '' : 's'} missing FX rates — excluded above
        </Badge>
      )}

      {view && view.rows.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowEquation((v) => !v)}
            className="text-xs font-medium text-accent-700 dark:text-accent-400 press-scale"
            aria-expanded={showEquation}
          >
            How this adds up {showEquation ? '▲' : '▼'}
          </button>
          {showEquation && (
            <dl className="mt-2 space-y-1 text-sm">
              {view.rows.map((row) => (
                <div
                  key={row.key}
                  className={`flex items-baseline justify-between gap-3 ${row.strong ? 'border-t border-[var(--border-subtle)] pt-1 font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}
                >
                  <dt className="min-w-0">
                    {row.sign && <span className="inline-block w-4 text-[var(--text-muted)]" aria-hidden="true">{row.sign}</span>}
                    {row.label}
                  </dt>
                  {row.amount && <dd className="shrink-0 tabular-nums">{row.amount}</dd>}
                </div>
              ))}
              {view.footnote && <p className="pt-0.5 text-xs text-[var(--text-muted)]">{view.footnote}</p>}
              {view.foreignNote && <p className="pt-0.5 text-xs text-[var(--text-muted)]">{view.foreignNote}</p>}
            </dl>
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        {position.perPerson.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs font-medium text-accent-700 dark:text-accent-400 press-scale"
            aria-expanded={expanded}
          >
            {expanded ? 'Hide' : 'Show'} per-person breakdown {expanded ? '▲' : '▼'}
          </button>
        )}
        {/* Mid-trip payments are first-class (they're just P2P transactions):
            recording one shouldn't wait for an end-of-trip settle screen, so
            the Settle-up flow -- where payments are recorded and tracked --
            is always reachable right next to the balances. */}
        <button type="button" onClick={onSettleUp} className="text-xs font-medium text-accent-700 dark:text-accent-400 press-scale">
          💸 Record a payment
        </button>
      </div>

      {position.perPerson.length > 0 && expanded && (
        <div className="space-y-2 stagger-list">
          {position.perPerson.map((row) => {
            const person = byUserId.get(row.userId)
            const personName = person?.user?.full_name || person?.user?.email || 'Former member'
            const theyOweMe = row.netMinor > 0
            const isOpen = expandedPersonId === row.userId
            const ledger = isOpen
              ? computePairwiseLedger(expenses, settlementsWithCarryovers, currentUserId, row.userId, baseCurrency)
              : []
            return (
              <div key={row.userId} className="stagger-item">
                <button
                  type="button"
                  onClick={() => setExpandedPersonId((v) => (v === row.userId ? null : row.userId))}
                  aria-expanded={isOpen}
                  className="w-full flex items-center gap-2.5 text-left press-scale"
                >
                  <UserAvatar avatarData={person?.user} size="xs" alt={personName} />
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">{personName}</span>
                  <span className={`text-sm font-medium tabular-nums ${theyOweMe ? 'text-success-600' : 'text-danger-600'}`}>
                    {theyOweMe ? 'owes you ' : 'you owe '}
                    {formatMoneyMinor(Math.abs(row.netMinor), baseCurrency)}
                  </span>
                  <span className="text-[var(--text-muted)] text-[10px] shrink-0" aria-hidden="true">
                    {isOpen ? '▲' : '▼'}
                  </span>
                </button>

                {isOpen && (
                  <div className="mt-1.5 ml-8 space-y-1 border-l border-[var(--border-subtle)] pl-3">
                    {ledger.map((entry) => (
                      <div key={entry.id} className={`flex items-baseline gap-2 text-xs ${entry.pending ? 'opacity-60' : ''}`}>
                        <span className="shrink-0 w-11 text-[var(--text-muted)] tabular-nums">{ledgerDateLabel(entry.date)}</span>
                        <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">
                          {entry.kind === 'expense' ? entry.label : <>💸 {ledgerEntryLabel(entry, personName)}</>}
                          {entry.note && <span className="text-[var(--text-muted)]"> · {entry.note}</span>}
                          {entry.pending && <span className="text-warning-600"> · pending</span>}
                        </span>
                        <span
                          className={`shrink-0 font-medium tabular-nums ${entry.amountMinor >= 0 ? 'text-success-600' : 'text-danger-600'}`}
                        >
                          {entry.amountMinor >= 0 ? '+' : '−'}
                          {formatMoneyMinor(Math.abs(entry.amountMinor), baseCurrency)}
                        </span>
                      </div>
                    ))}
                    <p className="pt-0.5 text-[10px] text-[var(--text-muted)]">
                      + raises what {personName} owes you · − lowers it{ledger.some((e) => e.pending) ? ' · pending payments not counted yet' : ''}
                    </p>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
