import { useState } from 'react'
import { Button, Modal, Spinner, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useLeftoversPreview, useShareLeftovers } from '../../../lib/queries/useExpenses'
import type { LeftoverMode } from '../../../lib/queries/useExpenses'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { Expense } from '../../../types'
import { formatMoneyMinor } from '../lib/formatMoney'
import { nameOfUser, peopleOnReceipt } from './claimPeople'

export interface LeftoversSheetProps {
  isOpen: boolean
  onClose: () => void
  expense: Expense
  participants: ParticipantWithUser[]
  /** Unclaimed value of the receipt, minor units. */
  unclaimedMinor: number
  /** Called after the leftovers were placed. */
  onShared?: () => void
}

const RULE_EVERYONE =
  'Shared equally between everyone on the receipt. No one is charged more than an even share of the bill while others are below it.'

/**
 * For the payer / people who manage the trip, when a receipt has value nobody
 * is paying for. Three honest choices; nothing is placed until they confirm,
 * and "Share between everyone" shows the server's own preview first.
 */
export function LeftoversSheet({ isOpen, onClose, expense, participants, unclaimedMinor, onShared }: LeftoversSheetProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const share = useShareLeftovers()
  const [choice, setChoice] = useState<LeftoverMode | null>(null)
  const [personId, setPersonId] = useState<string | null>(null)
  const currency = expense.currency
  const people = peopleOnReceipt(expense, participants)
  const payerName = expense.paid_by === user?.id ? 'You' : nameOfUser(expense.paid_by, participants)
  const amount = formatMoneyMinor(unclaimedMinor, currency)

  const previewArgs = isOpen && (choice === 'everyone' || (choice === 'person' && personId)) ? { expenseId: expense.id, mode: choice, userId: personId, currency } : null
  const preview = useLeftoversPreview(previewArgs)

  const confirm = async () => {
    if (!choice) return
    try {
      await share.mutateAsync({ expenseId: expense.id, mode: choice, userId: choice === 'person' ? personId : null, currency })
      showToast({
        type: 'success',
        message: choice === 'everyone' ? `${amount} shared between everyone on the receipt` : choice === 'payer' ? `${payerName === 'You' ? "You're" : `${payerName} is`} covering ${amount}` : `${amount} given to ${nameOfUser(personId, participants)}`,
      })
      onShared?.()
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: "Couldn't place the leftovers", description: err instanceof Error ? err.message : undefined })
    }
  }

  const canConfirm = choice === 'everyone' || choice === 'payer' || (choice === 'person' && !!personId)
  const confirmLabel =
    choice === 'everyone' ? 'Share between everyone' : choice === 'payer' ? (payerName === 'You' ? "I'll cover it" : `${payerName} covers it`) : choice === 'person' && personId ? `Give to ${nameOfUser(personId, participants)}` : 'Choose one'

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`${amount} isn't claimed`}>
      <div className="space-y-4">
        <p className="text-sm text-[var(--text-secondary)]">
          On {expense.vendor_name || expense.description}. Until someone is put down for it, it is counted as {payerName === 'You' ? 'yours' : `${payerName}'s`}. Choose who pays it.
        </p>

        <div role="radiogroup" aria-label="Who pays the rest" className="space-y-2">
          <ChoiceButton selected={choice === 'everyone'} onClick={() => setChoice('everyone')} title="Share between everyone on the receipt" detail={`${people.length} ${people.length === 1 ? 'person' : 'people'}`} />
          <ChoiceButton selected={choice === 'person'} onClick={() => setChoice('person')} title="Assign to someone…" detail="All of it goes to one person" />
          <ChoiceButton selected={choice === 'payer'} onClick={() => setChoice('payer')} title="I'll cover it" detail={payerName === 'You' ? 'You pay it. Nobody else is charged.' : `${payerName} pays it. Nobody else is charged.`} />
        </div>

        {choice === 'person' && (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Give the rest to">
            {people.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={personId === p.id}
                onClick={() => setPersonId(p.id)}
                className={`min-h-11 px-4 rounded-[var(--radius-full)] border text-sm font-medium ${
                  personId === p.id ? 'bg-accent-600 border-accent-600 text-white' : 'bg-[var(--surface-raised)] border-[var(--border-default)] text-[var(--text-secondary)]'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}

        {previewArgs && (
          <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-3 space-y-2" aria-live="polite">
            {preview.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                <Spinner size="sm" /> Working out who gets what…
              </div>
            ) : preview.error ? (
              <p className="text-sm text-[var(--text-secondary)]">Couldn't work that out. {(preview.error as Error).message}</p>
            ) : (
              <>
                <ul className="space-y-1">
                  {(preview.data?.shares ?? [])
                    .filter((s) => s.amountMinor > 0)
                    .map((s) => (
                      <li key={s.userId} className="flex items-baseline justify-between gap-2 text-sm">
                        <span className="text-[var(--text-primary)]">{nameOfUser(s.userId, participants)}</span>
                        <span className="tabular-nums text-[var(--text-primary)]">
                          +{formatMoneyMinor(s.amountMinor, currency)}
                          {s.totalAfterMinor != null && <span className="text-xs text-[var(--text-muted)]"> · {formatMoneyMinor(s.totalAfterMinor, currency)} in all</span>}
                        </span>
                      </li>
                    ))}
                </ul>
                {choice === 'everyone' && <p className="text-xs text-[var(--text-muted)]">{RULE_EVERYONE}</p>}
              </>
            )}
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose}>
            Not now
          </Button>
          <Button variant="primary" onClick={confirm} disabled={!canConfirm || (!!previewArgs && preview.isLoading)} isLoading={share.isPending}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function ChoiceButton({ selected, onClick, title, detail }: { selected: boolean; onClick: () => void; title: string; detail: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={`w-full min-h-11 text-left rounded-[var(--radius-md)] border px-3 py-2.5 ${
        selected ? 'border-accent-600 bg-accent-50 dark:bg-accent-900/20' : 'border-[var(--border-default)] bg-[var(--surface-raised)]'
      }`}
    >
      <span className="block font-medium text-[var(--text-primary)]">{title}</span>
      <span className="block text-xs text-[var(--text-secondary)]">{detail}</span>
    </button>
  )
}
