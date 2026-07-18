import { useEffect, useRef, useState } from 'react'
import { Modal, Button, Input, Select, Spinner, ConfirmDiscardSheet, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { uploadReceipt } from '../../../lib/receiptUpload'
import { parseReceipt } from '../../../lib/receiptParsing'
import { useCreateExpense } from '../../../lib/queries/useExpenses'
import { useTripActivityLog } from '../../organizer/lib/activity'
import { largestRemainderDistribute, toMinorUnits, fromMinorUnits } from '../../../lib/money'
import { resolveExpenseFxFields, splitBaseCurrencyAmount } from '../../../lib/fx/resolveExpenseFxFields'
import { ALL_CATEGORIES, categoryIcon, categoryLabel } from '../lib/categoryStyle'
import { defaultTaggedParticipantIds } from '../lib/participantDefaults'
import { ExpenseEditorWizard } from '../editor/ExpenseEditorWizard'
import { useUnsavedChangesGuard } from '../../../lib/forms'
import { initialQuickCaptureState, applyParseResult } from './quickCaptureState'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Trip } from '../../../types'

/** Staged progress copy for the parsing wait (5-20s) so the spinner isn't static -- the second label kicks in once a real parse would plausibly be past initial upload/OCR into the reconciliation pass. */
const PARSING_LABEL_SWITCH_MS = 6000

export interface QuickCaptureSheetProps {
  isOpen: boolean
  onClose: () => void
  trip: Trip
  participants: ParticipantWithUser[]
  allExpenses: ExpenseWithDetails[]
}

/**
 * Quick capture (plan §10 #1, the flagship flow): photo/file -> upload ->
 * parse-receipt -> "does this look right?" confirmation card with smart
 * defaults (payer=me, date=today, split=all tagged participants equally)
 * -> save in <=3 taps. "Refine later" opens the full editor. If parsing
 * fails, falls back to graceful manual entry with the photo attached.
 *
 * Remount this component with a fresh `key` (e.g. tied to a
 * `openCount`/timestamp) every time it's opened from the shell's "+" FAB so
 * no previous capture's state leaks in (Form & Flow Standard point 2).
 */
export function QuickCaptureSheet({ isOpen, onClose, trip, participants, allExpenses }: QuickCaptureSheetProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const createExpense = useCreateExpense(trip.id)
  const logActivity = useTripActivityLog(trip.id)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const today = new Date().toISOString().slice(0, 10)
  const [state, setState] = useState(() => initialQuickCaptureState(today))
  const [showFullEditor, setShowFullEditor] = useState(false)
  const [parsingElapsedMs, setParsingElapsedMs] = useState(0)

  // Staged progress feedback (plan §10 #4): a static spinner for 5-20s reads
  // as broken. Ticks a local timer while we wait on parse-receipt so the
  // label can advance and elapsed seconds can show once it's been a while --
  // client-side only (no real per-step signal from the edge function today).
  useEffect(() => {
    if (state.stage !== 'parsing') {
      setParsingElapsedMs(0)
      return
    }
    const startedAt = Date.now()
    const interval = setInterval(() => setParsingElapsedMs(Date.now() - startedAt), 500)
    return () => clearInterval(interval)
  }, [state.stage])

  const resetAndClose = () => {
    setState(initialQuickCaptureState(today))
    setShowFullEditor(false)
    onClose()
  }

  // Confirm-stage dirty guard (audit finding #2): once a receipt has been
  // parsed and we're showing the editable vendor/total/date/category form,
  // there's real work (the parse + any edits) a stray backdrop click or
  // Escape would silently throw away. Derived straight from `stage` rather
  // than tracked separately -- reaching 'confirm' always means there's a
  // parsed receipt to lose, and leaving it (save, or falling back to
  // manual/full-editor) always means it no longer applies.
  const isConfirmDirty = state.stage === 'confirm'
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isConfirmDirty)
  const requestClose = () => confirmClose(resetAndClose)

  const handleFilePicked = async (file: File) => {
    if (!user) return
    setState((s) => ({ ...s, file, stage: 'uploading' }))
    try {
      const uploaded = await uploadReceipt(file, user.id)
      setState((s) => ({ ...s, receiptPath: uploaded.path, stage: 'parsing' }))

      try {
        const parsed = await parseReceipt(uploaded.path, trip.id)
        setState((s) => applyParseResult(s, parsed, today))
      } catch (parseErr) {
        setState((s) => ({
          ...s,
          stage: 'manual',
          parseError: parseErr instanceof Error ? parseErr.message : 'Could not read this receipt',
        }))
      }
    } catch (uploadErr) {
      showToast({
        type: 'error',
        message: 'Upload failed',
        description: uploadErr instanceof Error ? uploadErr.message : undefined,
      })
      setState((s) => ({ ...s, stage: 'pick' }))
    }
  }

  const handleQuickSave = async () => {
    if (!user) return
    const totalMajor = parseFloat(state.total) || 0
    if (totalMajor <= 0) {
      showToast({ type: 'error', message: 'Enter a valid amount' })
      return
    }

    setState((s) => ({ ...s, stage: 'saving' }))
    try {
      // Smart defaults (plan): payer = me, split = tagged participants
      // equally. "Tagged participants" defaults to confirmed participants
      // (falling back to everyone if nobody's confirmed yet) -- declined/
      // pending people shouldn't be pre-tagged into expenses or auto-chased
      // (refine later lets you narrow/widen it either way).
      const participantIds = defaultTaggedParticipantIds(participants)
      const totalMinor = toMinorUnits(totalMajor, state.currency)
      const shares = largestRemainderDistribute(totalMinor, participantIds.map(() => 1))

      // Foreign-currency receipts: persist an auto-fetched FX rate so the
      // expense counts in balances (best-effort; null fields on failure --
      // the balances screen flags the missing rate).
      const fx = await resolveExpenseFxFields({
        amountMajor: totalMajor,
        currency: state.currency,
        baseCurrency: trip.base_currency,
        paymentDate: state.date,
      })

      const created = await createExpense.mutateAsync({
        expense: {
          description: state.vendor || 'Receipt',
          amount: totalMajor,
          currency: state.currency,
          category: state.category as ExpenseWithDetails['category'],
          vendor_name: state.vendor || null,
          payment_date: state.date,
          paid_by: user.id,
          participant_ids: participantIds,
          receipt_url: state.receiptPath,
          ai_parsed: !!state.parsed,
          fx_rate: fx.fx_rate,
          fx_rate_date: fx.fx_rate_date,
          base_currency_amount: fx.base_currency_amount,
          rate_source: fx.rate_source,
        },
        splits: participantIds.map((userId, i) => ({
          user_id: userId,
          amount: fromMinorUnits(shares[i], state.currency),
          split_type: 'equal' as const,
          base_currency_amount: splitBaseCurrencyAmount(fromMinorUnits(shares[i], state.currency), fx),
        })),
      })
      logActivity({ verb: 'expense_added', entity: { type: 'expense', id: created.id, label: created.description } })

      showToast({ type: 'success', message: 'Expense saved' })
      resetAndClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Failed to save', description: err instanceof Error ? err.message : undefined })
      setState((s) => ({ ...s, stage: 'confirm' }))
    }
  }

  if (showFullEditor) {
    return (
      <ExpenseEditorWizard
        key={state.receiptPath ?? 'quick-capture-refine'}
        isOpen={isOpen}
        onClose={resetAndClose}
        trip={trip}
        participants={participants}
        allExpenses={allExpenses}
        initialReceiptPath={state.receiptPath}
        // Carries the v2 parse result (with real line items) into the full
        // editor so "Refine later" -> Itemized isn't a blank draft -- this
        // was the itemization regression: the parse result was read into
        // local state but never handed off past this screen.
        initialParsedReceipt={state.parsed?.v2?.receipt ?? null}
      />
    )
  }

  return (
    <Modal isOpen={isOpen} onClose={requestClose} title="Quick capture" size="sm">
      {state.stage === 'pick' && (
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">Snap a receipt or pick a photo — we'll read it for you.</p>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/jpg,image/png,image/heic,image/heif,application/pdf"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleFilePicked(file)
            }}
          />
          <Button variant="primary" fullWidth leftIcon={<span>📷</span>} onClick={() => fileInputRef.current?.click()}>
            Take photo / choose file
          </Button>
          <Button variant="ghost" fullWidth onClick={() => setShowFullEditor(true)}>
            Enter manually instead
          </Button>
        </div>
      )}

      {(state.stage === 'uploading' || state.stage === 'parsing') && (
        <div className="flex flex-col items-center justify-center py-10 gap-2">
          <Spinner size="lg" />
          <p className="text-sm text-[var(--text-secondary)]">
            {state.stage === 'uploading'
              ? 'Uploading photo…'
              : parsingElapsedMs < PARSING_LABEL_SWITCH_MS
                ? 'Reading the receipt…'
                : 'Checking the totals…'}
          </p>
          {state.stage === 'parsing' && parsingElapsedMs > 5000 && (
            <p className="text-xs text-[var(--text-muted)] tabular-nums">{Math.floor(parsingElapsedMs / 1000)}s</p>
          )}
        </div>
      )}

      {state.stage === 'confirm' && (
        <div className="space-y-4">
          <p className="text-sm font-medium text-[var(--text-primary)]">Does this look right?</p>

          <Input label="Vendor" value={state.vendor} onChange={(e) => setState((s) => ({ ...s, vendor: e.target.value }))} />

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Total"
              inputMode="decimal"
              value={state.total}
              onChange={(e) => setState((s) => ({ ...s, total: e.target.value }))}
              leftAddon={state.currency}
            />
            <Input type="date" label="Date" value={state.date} onChange={(e) => setState((s) => ({ ...s, date: e.target.value }))} />
          </div>

          <Select
            label="Category"
            value={state.category}
            onChange={(e) => setState((s) => ({ ...s, category: e.target.value }))}
            options={ALL_CATEGORIES.map((c) => ({ value: c, label: `${categoryIcon(c)} ${categoryLabel(c)}` }))}
          />

          <p className="text-xs text-[var(--text-muted)]">
            Split equally among {defaultTaggedParticipantIds(participants).length} confirmed trip participant
            {defaultTaggedParticipantIds(participants).length === 1 ? '' : 's'}. Paid by you. Refine later to change either.
          </p>

          <div className="flex items-center gap-3 pt-1">
            <Button variant="secondary" onClick={() => setShowFullEditor(true)} disabled={state.stage !== 'confirm'}>
              Refine later
            </Button>
            <Button variant="primary" fullWidth onClick={handleQuickSave} isLoading={state.stage === ('saving' as typeof state.stage)}>
              Save
            </Button>
          </div>
        </div>
      )}

      {state.stage === 'manual' && (
        <div className="space-y-4">
          <div className="rounded-[var(--radius-md)] border border-warn-200 bg-warn-50 dark:bg-warn-900 dark:border-warn-800 px-3 py-2.5 text-sm text-warn-700 dark:text-warn-300">
            Couldn't read this receipt automatically{state.parseError ? `: ${state.parseError}` : ''}. The photo's attached — just fill in the details.
          </div>
          <Button variant="primary" fullWidth onClick={() => setShowFullEditor(true)}>
            Enter details manually
          </Button>
        </div>
      )}

      {state.stage === 'saving' && (
        <div className="flex flex-col items-center justify-center py-10 gap-3">
          <Spinner size="lg" />
          <p className="text-sm text-[var(--text-secondary)]">Saving...</p>
        </div>
      )}

      <ConfirmDiscardSheet isOpen={guardProps.showConfirm} onKeep={guardProps.onKeep} onDiscard={guardProps.onDiscard} />
    </Modal>
  )
}
