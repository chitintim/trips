import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Card, useToast } from '../../../components/ui'
import { useUnsavedChangesGuard } from '../../../lib/forms'
import { toMinorUnits } from '../../../lib/money'
import { useSetReceiptClaims, useShareLeftovers } from '../../../lib/queries/useExpenses'
import type { ReceiptClaimEntry } from '../../../lib/queries/useExpenses'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { Expense } from '../../../types'
import { formatMoneyMinor } from '../lib/formatMoney'
import { formatClaimQuantity } from './claimFractions'
import { peopleOnReceipt } from './claimPeople'
import { shareLineMinor, hasDirectUnitClaims, REPLACES_OWN_ENTRIES_WARNING } from './claimMath'
import { describeClaimError } from './claimErrors'
import type { ClaimRow, LineRow } from './claimMath'

/** Who a line belongs to: a list of people (shared equally) or the whole table. */
type Assign = string[] | 'all'

const SAVE_DELAY_MS = 1200
const EQUAL_TOLERANCE = 0.011

function sameAssign(a: Assign, b: Assign): boolean {
  if (a === 'all' || b === 'all') return a === b
  return a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i])
}

export interface WhoHadWhatProps {
  expense: Expense
  lineItems: LineRow[]
  claims: ClaimRow[]
  participants: ParticipantWithUser[]
  /** Balances are frozen: show, don't change. */
  disabled?: boolean
  /** Called after everything has been saved and the person taps "Done". */
  onDone?: () => void
  /** Open the leftovers sheet (hidden when not available). */
  onOpenLeftovers?: () => void
}

/**
 * "Who had what" -- the payer (or someone who manages the trip) puts people on
 * each line: tap a name = that person had it, tap several = shared equally,
 * Everyone = a table item. Also "pass the phone": friends tap their own name.
 *
 * Saving: every tap is shown at once (the screen never waits on the network).
 * About a second after the last tap only the lines that CHANGED are sent
 * (the server replaces each listed line and touches no other), so a retry is
 * always safe. A failed save keeps every tap, says so, and offers "Try again";
 * it also retries by itself when the phone comes back online. "Done" saves
 * anything still pending before it leaves.
 */
export function WhoHadWhat({ expense, lineItems, claims, participants, disabled = false, onDone, onOpenLeftovers }: WhoHadWhatProps) {
  const { showToast } = useToast()
  const setClaims = useSetReceiptClaims()
  const shareLeftovers = useShareLeftovers()
  const currency = expense.currency
  const people = useMemo(() => peopleOnReceipt(expense, participants, claims), [expense, participants, claims])
  const peopleIds = useMemo(() => people.map((p) => p.id), [people])
  const labelOf = useCallback((id: string) => people.find((p) => p.id === id)?.label ?? 'Someone', [people])

  // What the server has: per line, who is on it (leftover rows are derived and ignored here).
  const serverLines = useMemo(() => {
    const result = new Map<string, { assign: Assign; custom: string | null; amounts: Map<string, number>; hasLeftover: boolean }>()
    for (const li of lineItems) {
      const rows = claims.filter((c) => c.line_item_id === li.id)
      const own = rows.filter((c) => c.source !== 'leftover')
      const amounts = new Map<string, number>()
      for (const r of own) amounts.set(r.user_id, (amounts.get(r.user_id) ?? 0) + toMinorUnits(r.amount_owed, currency))
      const ids = [...new Set(own.map((r) => r.user_id))]
      const qtys = ids.map((id) => own.filter((r) => r.user_id === id).reduce((s, r) => s + r.quantity_claimed, 0))
      const sum = qtys.reduce((a, b) => a + b, 0)
      const uneven = qtys.length > 0 && Math.max(...qtys) - Math.min(...qtys) > EQUAL_TOLERANCE
      const partial = ids.length > 0 && !li.shared_by_all && Math.abs(sum - li.quantity) > EQUAL_TOLERANCE
      let custom: string | null = null
      if (uneven || partial) custom = ids.map((id) => `${formatClaimQuantity(own.filter((r) => r.user_id === id).reduce((s, r) => s + r.quantity_claimed, 0))} ${labelOf(id)}`).join(' · ')
      result.set(li.id, {
        assign: li.shared_by_all ? 'all' : ids,
        custom,
        amounts,
        hasLeftover: rows.some((c) => c.source === 'leftover'),
      })
    }
    return result
  }, [lineItems, claims, currency, labelOf])

  // Local taps (shown at once) and what we last saved successfully.
  const [local, setLocal] = useState<Record<string, Assign>>({})
  const [saved, setSaved] = useState<Record<string, Assign>>({})
  const [undoStack, setUndoStack] = useState<Array<{ lineId: string; prev: Assign | undefined }>>([])
  const [assignee, setAssignee] = useState<string | null>(null)
  // The line whose "Start again" is waiting for a yes (it would replace what people entered themselves).
  const [confirmReset, setConfirmReset] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const localRef = useRef(local)
  const savedRef = useRef(saved)
  const serverRef = useRef(serverLines)
  localRef.current = local
  savedRef.current = saved
  serverRef.current = serverLines
  const inFlight = useRef(false)
  const again = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const baseline = useCallback((lineId: string): Assign => savedRef.current[lineId] ?? serverRef.current.get(lineId)?.assign ?? [], [])

  const dirtyLineIds = useMemo(
    () => Object.keys(local).filter((id) => !sameAssign(local[id], saved[id] ?? serverLines.get(id)?.assign ?? [])),
    [local, saved, serverLines]
  )

  // Once the server agrees with a tap, stop shadowing it, so later changes by
  // other people show up.
  useEffect(() => {
    setLocal((prev) => {
      let changed = false
      const next = { ...prev }
      for (const id of Object.keys(prev)) {
        const server = serverLines.get(id)?.assign
        if (server && sameAssign(prev[id], server) && sameAssign(prev[id], savedRef.current[id] ?? prev[id])) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [serverLines])

  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (inFlight.current) {
      again.current = true
      return false
    }
    const ids = Object.keys(localRef.current).filter((id) => !sameAssign(localRef.current[id], baseline(id)))
    if (ids.length === 0) {
      setStatus((s) => (s === 'saving' ? 'saved' : s))
      return true
    }
    const sent: Record<string, Assign> = {}
    const entries: ReceiptClaimEntry[] = ids.map((id) => {
      const a = localRef.current[id]
      sent[id] = a
      return a === 'all' ? { line_item_id: id, shared_by_all: true } : { line_item_id: id, user_ids: a }
    })
    inFlight.current = true
    setStatus('saving')
    let ok = false
    try {
      await setClaims.mutateAsync({ expenseId: expense.id, claims: entries })
      setSaved((prev) => ({ ...prev, ...sent }))
      savedRef.current = { ...savedRef.current, ...sent }
      // The server deletes every claim on a touched line, leftover rows
      // included; if leftovers had been shared, share them again the same way.
      const hadLeftover = ids.some((id) => serverRef.current.get(id)?.hasLeftover)
      if (hadLeftover) {
        try {
          await shareLeftovers.mutateAsync({ expenseId: expense.id, mode: 'same', currency })
        } catch {
          showToast({ type: 'info', message: 'The shared leftovers need sharing again', description: 'Open "Sort out the rest" to place what is still unclaimed.' })
        }
      }
      setErrorMsg(null)
      setStatus('saved')
      ok = true
    } catch (err) {
      setErrorMsg(describeClaimError(err, 'Could not save'))
      setStatus('error')
    } finally {
      inFlight.current = false
      if (again.current) {
        again.current = false
        void flush()
      }
    }
    return ok
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expense.id, currency, baseline])

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS)
  }, [flush])

  // Try again by itself when the connection returns.
  useEffect(() => {
    const online = () => {
      if (Object.keys(localRef.current).some((id) => !sameAssign(localRef.current[id], baseline(id)))) void flush()
    }
    window.addEventListener('online', online)
    return () => {
      window.removeEventListener('online', online)
      if (timer.current) clearTimeout(timer.current)
    }
  }, [flush, baseline])

  useUnsavedChangesGuard(dirtyLineIds.length > 0 || status === 'saving')

  const effective = useCallback((lineId: string): Assign => local[lineId] ?? serverLines.get(lineId)?.assign ?? [], [local, serverLines])

  const setLine = (lineId: string, next: Assign) => {
    if (disabled) return
    setUndoStack((u) => [...u.slice(-49), { lineId, prev: localRef.current[lineId] }])
    setLocal((prev) => ({ ...prev, [lineId]: next }))
    setStatus((s) => (s === 'error' ? 'idle' : s))
    schedule()
  }

  const togglePerson = (lineId: string, personId: string) => {
    const cur = effective(lineId)
    if (cur === 'all') return setLine(lineId, [personId])
    setLine(lineId, cur.includes(personId) ? cur.filter((x) => x !== personId) : [...cur, personId])
  }
  const toggleEveryone = (lineId: string) => setLine(lineId, effective(lineId) === 'all' ? [] : 'all')

  const undo = () => {
    const last = undoStack[undoStack.length - 1]
    if (!last) return
    setUndoStack((u) => u.slice(0, -1))
    setLocal((prev) => {
      const next = { ...prev }
      if (last.prev === undefined) {
        // Back to what the server (or the last save) had.
        next[last.lineId] = savedRef.current[last.lineId] ?? serverRef.current.get(last.lineId)?.assign ?? []
      } else next[last.lineId] = last.prev
      return next
    })
    schedule()
  }

  // Running totals and what is still unassigned (minor units).
  const { totals, unassignedCount, unassignedMinor } = useMemo(() => {
    const totals = new Map<string, number>(peopleIds.map((id) => [id, 0]))
    let unassignedCount = 0
    let unassignedMinor = 0
    for (const li of lineItems) {
      const lineMinor = toMinorUnits(li.total_amount, currency)
      const sv = serverLines.get(li.id)
      const loc = local[li.id]
      let assignedMinor = 0
      if (loc !== undefined) {
        const ids = loc === 'all' ? peopleIds : loc
        const shares = shareLineMinor(lineMinor, ids)
        for (const [id, m] of shares) {
          totals.set(id, (totals.get(id) ?? 0) + m)
          assignedMinor += m
        }
      } else if (sv) {
        for (const [id, m] of sv.amounts) {
          totals.set(id, (totals.get(id) ?? 0) + m)
          assignedMinor += m
        }
      }
      const left = Math.max(0, lineMinor - assignedMinor)
      if (left > 0) {
        unassignedCount += 1
        unassignedMinor += left
      }
    }
    return { totals, unassignedCount, unassignedMinor }
  }, [lineItems, local, serverLines, peopleIds, currency])

  const handleDone = async () => {
    if (dirtyLineIds.length > 0 || inFlight.current) {
      if (inFlight.current) {
        showToast({ type: 'info', message: 'Still saving — one moment' })
        again.current = true
        return
      }
      const ok = await flush()
      if (!ok) {
        showToast({ type: 'error', message: "Your last changes aren't saved yet", description: 'Your taps are kept. Try again.' })
        return
      }
    }
    onDone?.()
  }

  const assigneeLabel = assignee ? labelOf(assignee) : null

  return (
    <div className="space-y-3 pb-28">
      {/* Sticky summary: what is left, save state, undo. */}
      <div className="sticky top-0 z-20 -mx-4 px-4 py-2 bg-[var(--surface-page)] border-b border-[var(--border-subtle)] space-y-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-[var(--text-primary)]" aria-live="polite">
            {unassignedCount === 0
              ? 'Everything is assigned ✓'
              : `Unassigned (${unassignedCount} ${unassignedCount === 1 ? 'item' : 'items'} · ${formatMoneyMinor(unassignedMinor, currency)})`}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={undo}
              disabled={undoStack.length === 0 || disabled}
              className="min-h-11 px-3 text-sm font-medium text-accent-700 dark:text-accent-400 disabled:opacity-30"
            >
              Undo
            </button>
          </div>
        </div>
        <SaveStatus status={status} pending={dirtyLineIds.length} errorMsg={errorMsg} onRetry={() => void flush()} />
      </div>

      {disabled && <p className="text-sm text-[var(--text-secondary)]">🔒 Balances are frozen, so this can't be changed. An organizer can unfreeze them.</p>}

      <p className="text-sm text-[var(--text-secondary)]">
        Tap a name under each item. Tap several for a shared item, or Everyone for the table. Pass the phone round — friends can tap their own name.
      </p>

      {/* Sticky "Assign to…" mode. */}
      <Card noPadding className="p-3 space-y-2">
        <p className="text-sm font-medium text-[var(--text-primary)]">Assign to…</p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Assign to">
          {people.map((p) => (
            <ChipButton key={p.id} pressed={assignee === p.id} onClick={() => setAssignee(assignee === p.id ? null : p.id)} label={`Assign to ${p.label}`} disabled={disabled}>
              {p.label}
            </ChipButton>
          ))}
        </div>
        <p className="text-xs text-[var(--text-muted)]">
          {assigneeLabel ? `Assigning to ${assigneeLabel}: tap each item ${assigneeLabel} had. Tap again to take it off.` : 'Pick a person once, then tap all their items.'}
        </p>
      </Card>

      <div className="space-y-2">
        {lineItems.map((li) => {
          const sv = serverLines.get(li.id)
          const cur = effective(li.id)
          const name = li.name_english || li.name_original
          const sharedCount = cur === 'all' ? people.length : cur.length
          const custom = local[li.id] === undefined ? sv?.custom : null
          return (
            <Card key={li.id} noPadding className="p-3 space-y-2">
              <button
                type="button"
                disabled={disabled || !assignee || !!custom}
                onClick={() => assignee && togglePerson(li.id, assignee)}
                className={`w-full text-left flex items-start justify-between gap-3 rounded-[var(--radius-sm)] ${assignee && !custom ? 'min-h-11' : ''} disabled:cursor-default`}
                aria-label={assignee ? `${name}: ${assigneeLabel} ${cur !== 'all' && cur.includes(assignee) ? 'had it, tap to remove' : 'tap to assign'}` : name}
              >
                <span className="min-w-0">
                  <span className="block font-medium text-[var(--text-primary)] truncate">
                    <span className="text-[var(--text-muted)] font-normal tabular-nums">{li.line_number}.</span> {name}
                  </span>
                  {li.name_english && li.name_original && li.name_original !== li.name_english && (
                    <span className="block text-xs text-[var(--text-secondary)] truncate">{li.name_original}</span>
                  )}
                  {li.quantity !== 1 && <span className="block text-xs text-[var(--text-muted)]">× {li.quantity}</span>}
                </span>
                <span className="shrink-0 text-right">
                  <span className="block font-medium tabular-nums text-[var(--text-primary)]">{formatMoneyMinor(toMinorUnits(li.total_amount, currency), currency)}</span>
                  {sharedCount > 1 && <span className="block text-xs text-accent-700 dark:text-accent-400 font-medium">÷{sharedCount}</span>}
                </span>
              </button>

              {custom ? (
                <div className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] bg-[var(--surface-sunken)] px-3 py-2">
                  <p className="text-xs text-[var(--text-secondary)]">
                    {confirmReset === li.id ? `${REPLACES_OWN_ENTRIES_WARNING} Start again?` : `Split unevenly: ${custom}`}
                  </p>
                  {confirmReset === li.id ? (
                    <div className="flex shrink-0">
                      <button type="button" onClick={() => setConfirmReset(null)} className="min-h-11 px-3 text-sm font-medium text-[var(--text-secondary)]">
                        Keep
                      </button>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          setConfirmReset(null)
                          setLine(li.id, [])
                        }}
                        className="min-h-11 px-3 text-sm font-medium text-accent-700 dark:text-accent-400"
                      >
                        Replace
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => (hasDirectUnitClaims(li, claims.filter((c) => c.line_item_id === li.id)) ? setConfirmReset(li.id) : setLine(li.id, []))}
                      className="min-h-11 px-3 text-sm font-medium text-accent-700 dark:text-accent-400 shrink-0"
                    >
                      Start again
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex flex-wrap gap-2" role="group" aria-label={`Who had ${name}`}>
                  {people.map((p) => (
                    <ChipButton
                      key={p.id}
                      pressed={cur !== 'all' && cur.includes(p.id)}
                      onClick={() => togglePerson(li.id, p.id)}
                      label={`${p.label}, ${name}`}
                      disabled={disabled}
                    >
                      {p.label}
                    </ChipButton>
                  ))}
                  <ChipButton pressed={cur === 'all'} onClick={() => toggleEveryone(li.id)} label={`Everyone, ${name}`} disabled={disabled} wide>
                    Everyone{cur === 'all' ? ` ÷${people.length}` : ''}
                  </ChipButton>
                </div>
              )}
            </Card>
          )
        })}
      </div>

      <Card noPadding className="p-3 space-y-2">
        <p className="text-sm font-medium text-[var(--text-primary)]">So far</p>
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
          {people.map((p) => (
            <li key={p.id} className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate text-[var(--text-secondary)]">{p.label}</span>
              <span className="tabular-nums text-[var(--text-primary)]">{formatMoneyMinor(totals.get(p.id) ?? 0, currency)}</span>
            </li>
          ))}
        </ul>
      </Card>

      <div className="fixed bottom-0 left-0 right-0 z-20 bg-[var(--surface-raised)] border-t border-[var(--border-subtle)] p-4 pb-safe">
        <div className="max-w-lg mx-auto flex items-center gap-3">
          {unassignedCount > 0 && onOpenLeftovers ? (
            <Button variant="secondary" onClick={onOpenLeftovers} className="min-h-11">
              Sort out the rest
            </Button>
          ) : (
            <span className="flex-1" />
          )}
          <Button variant="primary" className="ml-auto min-h-11" onClick={handleDone} isLoading={status === 'saving'}>
            Done
          </Button>
        </div>
      </div>
    </div>
  )
}

function SaveStatus({ status, pending, errorMsg, onRetry }: { status: string; pending: number; errorMsg: string | null; onRetry: () => void }) {
  if (status === 'error') {
    return (
      <div className="flex items-center justify-between gap-2 text-xs text-[var(--text-secondary)]" role="alert">
        <span>Not saved{errorMsg ? ` (${errorMsg})` : ''}. Your taps are kept.</span>
        <button type="button" onClick={onRetry} className="min-h-11 px-3 text-sm font-medium text-accent-700 dark:text-accent-400 shrink-0">
          Try again
        </button>
      </div>
    )
  }
  const text = status === 'saving' ? 'Saving…' : pending > 0 ? 'Saving in a moment…' : status === 'saved' ? 'Saved ✓' : ' '
  return (
    <p className="text-xs text-[var(--text-muted)]" aria-live="polite">
      {text}
    </p>
  )
}

function ChipButton({
  pressed,
  onClick,
  label,
  disabled,
  wide,
  children,
}: {
  pressed: boolean
  onClick: () => void
  label: string
  disabled?: boolean
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`min-h-11 px-4 rounded-[var(--radius-full)] border text-sm font-medium transition-colors disabled:opacity-40 ${wide ? 'border-dashed' : ''} ${
        pressed
          ? 'bg-accent-600 border-accent-600 text-white'
          : 'bg-[var(--surface-raised)] border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]'
      }`}
    >
      {children}
    </button>
  )
}
