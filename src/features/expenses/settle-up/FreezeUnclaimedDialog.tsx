import { useEffect, useMemo, useState } from 'react'
import { Button, Modal, Select, useToast } from '../../../components/ui'
import { useLeftoversPreview, useShareLeftovers } from '../../../lib/queries/useExpenses'
import { formatMoneyMinor } from '../lib/formatMoney'
import type { ReceiptClaimStatus } from '../lib/balances'
import {
  APPLY_AND_FREEZE,
  APPLY_TO_ALL,
  CHOICE_EVERYONE,
  CHOICE_EVERYONE_RECOMMENDED,
  CHOICE_PERSON,
  FREEZE_DIALOG_INTRO,
  FREEZE_DIALOG_TITLE,
  SERVER_REFUSED_NOTE,
  SERVER_REPORT_OVERCLAIMED_INTRO,
  SERVER_REPORT_OVERCLAIMED_TITLE,
  SERVER_REPORT_UNCLAIMED_INTRO,
  SERVER_REPORT_UNCLAIMED_TITLE,
  applyChoiceToAll,
  choiceIsComplete,
  coverChoiceLabel,
  notClaimedLine,
  planApplication,
  summariseApplication,
  type ApplyOutcome,
  type LeftoverChoice,
  type ServerReceiptReport,
} from './unclaimedReceipts'

export interface ReceiptCandidate {
  userId: string
  name: string
}

interface Props {
  isOpen: boolean
  onClose: () => void
  receipts: ReceiptClaimStatus[]
  viewerId: string | undefined
  nameOf: (userId: string) => string
  /** People a receipt's leftovers can be assigned to (the people on it). */
  candidatesFor: (expenseId: string) => ReceiptCandidate[]
  /** Called once every receipt's leftovers were placed: the caller re-reads the expenses and carries on with the freeze. */
  onAllShared: () => Promise<void> | void
  /** The server refused the freeze (hint unclaimed_receipts): say so. */
  serverRefused?: boolean
  /** What the server reported when it refused the freeze. Shown instead of the choices when the screen's own list disagrees (or for over-claims). */
  serverReport?: ServerReceiptReport | null
  /** The report's "Refresh": reload the latest expenses and claims. */
  onRefresh?: () => Promise<void> | void
  /** Currency of a receipt id (for printing the server's amounts). */
  currencyOf?: (expenseId: string) => string
}

/** Previews what "Share between everyone" would do for one receipt (nothing is written). Not shown while the dialog is closed. */
function EveryonePreview({ receipt, nameOf }: { receipt: ReceiptClaimStatus; nameOf: (id: string) => string }) {
  const { data, isLoading, isError } = useLeftoversPreview({ expenseId: receipt.expenseId, mode: 'everyone', currency: receipt.currency })
  if (isLoading) return <p className="pl-6 text-xs text-[var(--text-muted)]">Working out the split…</p>
  if (isError || !data || data.shares.length === 0) return null
  const parts = data.shares.filter((s) => s.amountMinor > 0).map((s) => `${nameOf(s.userId)} ${formatMoneyMinor(s.amountMinor, receipt.currency)}`)
  if (parts.length === 0) return null
  return <p className="pl-6 text-xs text-[var(--text-muted)]">Would add: {parts.join(' · ')}</p>
}

/**
 * Pressing Freeze while receipts still have unclaimed items opens this instead
 * of freezing. One card per receipt with the three choices from the claiming
 * model, plus "Apply to all". Placing the leftovers is one server call per
 * receipt (share_receipt_leftovers); only when all succeed does the freeze go on.
 */
export function FreezeUnclaimedDialog({ isOpen, onClose, receipts, viewerId, nameOf, candidatesFor, onAllShared, serverRefused, serverReport, onRefresh, currencyOf }: Props) {
  const { showToast } = useToast()
  const share = useShareLeftovers()
  const [choices, setChoices] = useState<Record<string, LeftoverChoice | undefined>>({})
  const [allPerson, setAllPerson] = useState('')
  const [running, setRunning] = useState(false)
  const [failures, setFailures] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!isOpen) {
      setChoices({})
      setAllPerson('')
      setFailures({})
    }
  }, [isOpen])

  const plan = useMemo(() => planApplication(receipts, choices), [receipts, choices])
  const canAssign = (expenseId: string, userId: string) => candidatesFor(expenseId).some((c) => c.userId === userId)

  const setChoice = (expenseId: string, c: LeftoverChoice) => setChoices((prev) => ({ ...prev, [expenseId]: c }))

  const apply = async () => {
    if (plan.missing.length > 0 || running) return
    setRunning(true)
    setFailures({})
    const outcome: ApplyOutcome = { done: [], failed: [] }
    for (const step of plan.steps) {
      try {
        await share.mutateAsync({ expenseId: step.expenseId, mode: step.mode, userId: step.userId, currency: step.currency })
        outcome.done.push(step.expenseId)
      } catch (err) {
        outcome.failed.push({ expenseId: step.expenseId, message: err instanceof Error ? err.message : 'Failed' })
      }
    }
    setRunning(false)
    const summary = summariseApplication(outcome, plan.steps.length)
    showToast({ type: summary.tone, message: summary.message })
    if (outcome.failed.length > 0) {
      setFailures(Object.fromEntries(outcome.failed.map((f) => [f.expenseId, f.message])))
      // Receipts that did go through drop out of the list by themselves once the expenses reload.
      return
    }
    await onAllShared()
  }

  const [refreshing, setRefreshing] = useState(false)
  const reportMode = !!serverReport && (serverReport.kind === 'overclaimed' || receipts.length === 0)

  if (reportMode && serverReport) {
    const over = serverReport.kind === 'overclaimed'
    return (
      <Modal isOpen={isOpen} onClose={onClose} title={over ? SERVER_REPORT_OVERCLAIMED_TITLE : SERVER_REPORT_UNCLAIMED_TITLE} size="lg">
        <div className="space-y-3">
          <p className="text-sm text-[var(--text-secondary)]">{over ? SERVER_REPORT_OVERCLAIMED_INTRO : SERVER_REPORT_UNCLAIMED_INTRO}</p>
          {serverReport.items.length > 0 && (
            <ul className="space-y-1.5 max-h-[50vh] overflow-y-auto">
              {serverReport.items.map((it) => (
                <li key={it.id} className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-3 text-sm text-[var(--text-primary)]">
                  {it.description}
                  {it.amountMinor != null && it.amountMinor > 0 ? ` — ${formatMoneyMinor(it.amountMinor, currencyOf?.(it.id) ?? 'GBP')} ${over ? 'too much claimed' : 'not claimed'}` : ''}
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="primary"
              isLoading={refreshing}
              onClick={async () => {
                setRefreshing(true)
                try {
                  await onRefresh?.()
                } finally {
                  setRefreshing(false)
                }
              }}
            >
              Refresh
            </Button>
          </div>
        </div>
      </Modal>
    )
  }

  const everyoneChoice: LeftoverChoice = { mode: 'everyone' }
  const payerChoice: LeftoverChoice = { mode: 'payer' }
  const busy = running

  return (
    <Modal isOpen={isOpen} onClose={busy ? () => undefined : onClose} title={FREEZE_DIALOG_TITLE} size="lg">
      <div className="space-y-3">
        <p className="text-sm text-[var(--text-secondary)]">{FREEZE_DIALOG_INTRO}</p>
        {serverRefused && (
          <p className="text-xs text-[var(--text-muted)]" role="status">
            {SERVER_REFUSED_NOTE}
          </p>
        )}

        {receipts.length > 1 && (
          <fieldset className="rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3 space-y-2">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{APPLY_TO_ALL}</legend>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setChoices(applyChoiceToAll(receipts, everyoneChoice))}>
                {CHOICE_EVERYONE}
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setChoices(applyChoiceToAll(receipts, payerChoice))}>
                Each payer covers their own
              </Button>
            </div>
            <div className="flex items-end gap-2">
              <Select
                label={CHOICE_PERSON}
                size="sm"
                value={allPerson}
                onChange={(e) => setAllPerson(e.target.value)}
                placeholder="Choose a person"
                options={uniqueCandidates(receipts, candidatesFor).map((c) => ({ value: c.userId, label: c.name }))}
              />
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || !allPerson}
                onClick={() => setChoices(applyChoiceToAll(receipts, { mode: 'person', userId: allPerson }, canAssign))}
              >
                Apply
              </Button>
            </div>
          </fieldset>
        )}

        <ul className="space-y-3 max-h-[50vh] overflow-y-auto">
          {receipts.map((r) => {
            const choice = choices[r.expenseId]
            const candidates = candidatesFor(r.expenseId)
            const name = `choice-${r.expenseId}`
            const payerName = nameOf(r.paidBy)
            return (
              <li key={r.expenseId} className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-3 space-y-2">
                <p className="text-sm font-medium text-[var(--text-primary)]">{notClaimedLine(r)}</p>
                <p className="text-xs text-[var(--text-muted)]">Paid by {payerName}</p>
                <fieldset className="space-y-1.5" disabled={busy}>
                  <legend className="sr-only">What happens to the rest of {r.description}</legend>
                  <label className="flex items-start gap-2 text-sm text-[var(--text-primary)]">
                    <input type="radio" name={name} className="mt-1" checked={choice?.mode === 'everyone'} onChange={() => setChoice(r.expenseId, everyoneChoice)} />
                    <span>{CHOICE_EVERYONE_RECOMMENDED}</span>
                  </label>
                  {/* Shown straight away, so the default path can be read before anything is picked. */}
                  <EveryonePreview receipt={r} nameOf={nameOf} />
                  <label className="flex items-start gap-2 text-sm text-[var(--text-primary)]">
                    <input
                      type="radio"
                      name={name}
                      className="mt-1"
                      checked={choice?.mode === 'person'}
                      onChange={() => setChoice(r.expenseId, { mode: 'person', userId: choice?.mode === 'person' ? choice.userId : undefined })}
                    />
                    <span>{CHOICE_PERSON}</span>
                  </label>
                  {choice?.mode === 'person' && (
                    <div className="pl-6">
                      <Select
                        aria-label={`Who gets the rest of ${r.description}`}
                        size="sm"
                        value={choice.userId ?? ''}
                        onChange={(e) => setChoice(r.expenseId, { mode: 'person', userId: e.target.value || undefined })}
                        placeholder="Choose a person"
                        options={candidates.map((c) => ({ value: c.userId, label: c.name }))}
                      />
                    </div>
                  )}
                  <label className="flex items-start gap-2 text-sm text-[var(--text-primary)]">
                    <input type="radio" name={name} className="mt-1" checked={choice?.mode === 'payer'} onChange={() => setChoice(r.expenseId, payerChoice)} />
                    <span>{coverChoiceLabel(viewerId, r.paidBy, payerName)}</span>
                  </label>
                </fieldset>
                {failures[r.expenseId] && (
                  <p className="text-xs text-danger-700 dark:text-danger-300" role="alert">
                    Couldn&apos;t share this one: {failures[r.expenseId]}
                  </p>
                )}
              </li>
            )
          })}
        </ul>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={apply} isLoading={busy} disabled={busy || plan.missing.length > 0 || !receipts.every((r) => choiceIsComplete(choices[r.expenseId]))}>
            {APPLY_AND_FREEZE}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function uniqueCandidates(receipts: ReceiptClaimStatus[], candidatesFor: (id: string) => ReceiptCandidate[]): ReceiptCandidate[] {
  const seen = new Map<string, ReceiptCandidate>()
  for (const r of receipts) for (const c of candidatesFor(r.expenseId)) if (!seen.has(c.userId)) seen.set(c.userId, c)
  return [...seen.values()]
}
