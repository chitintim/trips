import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal, Button, Spinner } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { uploadReceipt, ReceiptUploadError, RECEIPT_ACCEPT } from '../../../lib/receiptUpload'
import { parseReceipt, describeScanFailure, isReceiptScanCancelled, RECEIPT_SCAN_TIMEOUT_MS } from '../../../lib/receiptParsing'
import { ExpenseEditorWizard } from '../editor/ExpenseEditorWizard'
import { addExpenseBlockedMessage, ADD_EXPENSE_LABEL, SCAN_RECEIPT_CHOICE, ENTER_YOURSELF_CHOICE } from './addExpenseEntry'
import {
  initialQuickCaptureState, chooseScan, backToIdle, startScan, uploaded, uploadFailed, parseSucceeded, parseFailed,
  timedOut, cancel, retry, enterManually, failureActions, readingSubstage, showsEditor, READING_COPY,
  type QuickCaptureState,
} from './quickCaptureState'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Trip } from '../../../types'

const CHOICE_BUTTON =
  'w-full flex items-center gap-3 text-left rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-card)] hover:bg-[var(--surface-hover)] px-4 py-3 min-h-14 press-scale'

export interface QuickCaptureSheetProps {
  isOpen: boolean
  onClose: () => void
  trip: Trip
  participants: ParticipantWithUser[]
  allExpenses: ExpenseWithDetails[]
}

/**
 * Add expense entry: "Scan a receipt" (take a photo, or choose a photo or PDF)
 * or "Enter it yourself". A scan uploads the file, runs parse-receipt and then
 * opens the SAME one-screen expense form pre-filled with what was read. If the
 * scan fails, the sheet says why in plain words, offers Try again when that
 * can help, and always offers to enter it yourself with the photo attached.
 * All state transitions live in quickCaptureState.ts (pure, unit-tested).
 *
 * Remount this component with a fresh `key` (e.g. tied to a
 * `openCount`/timestamp) every time it's opened from the shell's "+" FAB so
 * no previous capture's state leaks in (Form & Flow Standard point 2).
 */
export function QuickCaptureSheet({ isOpen, onClose, trip, participants, allExpenses }: QuickCaptureSheetProps) {
  const { user } = useAuth()
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const libraryInputRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // The ref always holds the latest state so async steps can apply the pure
  // transitions (which ignore results from a stale runId) without stale closures.
  const stateRef = useRef<QuickCaptureState>(initialQuickCaptureState())
  const [state, setStateRaw] = useState<QuickCaptureState>(stateRef.current)
  const update = useCallback((fn: (s: QuickCaptureState) => QuickCaptureState) => {
    const next = fn(stateRef.current)
    stateRef.current = next
    setStateRaw(next)
    return next
  }, [])

  const fileRef = useRef<File | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [parseElapsedMs, setParseElapsedMs] = useState(0)

  const clearRunTimers = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = null
  }
  const abortRun = () => {
    clearRunTimers()
    abortRef.current?.abort()
    abortRef.current = null
  }

  // Abort any in-flight scan on unmount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => abortRun(), [])

  // Elapsed time of the parsing phase drives "Reading" -> "Checking the totals".
  const parsingPhase = state.stage === 'reading' && state.phase === 'parsing'
  useEffect(() => {
    if (!parsingPhase) {
      setParseElapsedMs(0)
      return
    }
    const startedAt = Date.now()
    const interval = setInterval(() => setParseElapsedMs(Date.now() - startedAt), 500)
    return () => clearInterval(interval)
  }, [parsingPhase, state.runId])

  // Focus the primary action of each new state.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      bodyRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [state.stage])

  const runParse = async (runId: number, receiptPath: string) => {
    const controller = new AbortController()
    abortRef.current = controller
    clearRunTimers()
    timeoutRef.current = setTimeout(() => {
      // Mark the run as timed out first, so the abort below is ignored.
      update((s) => timedOut(s, runId))
      controller.abort()
    }, RECEIPT_SCAN_TIMEOUT_MS)
    try {
      const parsed = await parseReceipt(receiptPath, trip.id, { signal: controller.signal })
      update((s) => parseSucceeded(s, runId, parsed))
    } catch (err) {
      // A user cancel or our own timeout is already reflected in state.
      if (isReceiptScanCancelled(err)) return
      update((s) => parseFailed(s, runId, describeScanFailure(err)))
    } finally {
      if (abortRef.current === controller) {
        clearRunTimers()
        abortRef.current = null
      }
    }
  }

  const runUpload = async (runId: number, file: File) => {
    if (!user) return
    try {
      const result = await uploadReceipt(file, user.id)
      if (stateRef.current.runId !== runId) return // cancelled while uploading
      update((s) => uploaded(s, runId, result.path))
      await runParse(runId, result.path)
    } catch (err) {
      const retryable = err instanceof ReceiptUploadError ? err.retryable : true
      const message = err instanceof ReceiptUploadError ? err.message : "We couldn't upload the photo. Check your connection and try again."
      update((s) => uploadFailed(s, runId, { message, retryable }))
    }
  }

  const handleFilePicked = (file: File) => {
    if (!user) return
    fileRef.current = file
    const next = update(startScan)
    void runUpload(next.runId, file)
  }

  const handleRetry = () => {
    const next = update(retry)
    if (next.stage !== 'reading') return
    if (next.receiptPath) void runParse(next.runId, next.receiptPath)
    else if (fileRef.current) void runUpload(next.runId, fileRef.current)
  }

  const handleCancel = () => {
    abortRun()
    update(cancel)
  }

  const resetAndClose = () => {
    abortRun()
    fileRef.current = null
    update(() => initialQuickCaptureState())
    onClose()
  }

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // lets the same file be picked again after a failure
    if (file) handleFilePicked(file)
  }

  const blockedMessage = addExpenseBlockedMessage(trip)

  if (showsEditor(state) && !blockedMessage) {
    return (
      <ExpenseEditorWizard
        key={state.receiptPath ?? 'quick-capture-form'}
        isOpen={isOpen}
        onClose={resetAndClose}
        trip={trip}
        participants={participants}
        allExpenses={allExpenses}
        initialReceiptPath={state.receiptPath}
        initialParsedData={state.parsed}
        initialParsedReceipt={state.parsed?.v2?.receipt ?? null}
      />
    )
  }

  const substage = readingSubstage(state, parseElapsedMs)
  const actions = failureActions(state)

  return (
    <Modal isOpen={isOpen} onClose={resetAndClose} title={ADD_EXPENSE_LABEL} size="sm">
      <div ref={bodyRef}>
        {blockedMessage && (
          <div className="space-y-4">
            <div className="rounded-[var(--radius-md)] border border-warn-200 bg-warn-50 dark:bg-warn-900 dark:border-warn-800 px-3 py-2.5 text-sm text-warn-700 dark:text-warn-300">
              🔒 {blockedMessage}
            </div>
            <Button variant="secondary" fullWidth onClick={resetAndClose}>
              Close
            </Button>
          </div>
        )}

        {!blockedMessage && state.stage === 'idle' && (
          <div className="space-y-3">
            <button
              type="button"
              data-autofocus
              onClick={() => update(chooseScan)}
              className={CHOICE_BUTTON}
            >
              <span className="text-2xl" aria-hidden="true">📷</span>
              <span>
                <span className="block font-medium text-[var(--text-primary)]">{SCAN_RECEIPT_CHOICE.label}</span>
                <span className="block text-sm text-[var(--text-secondary)]">{SCAN_RECEIPT_CHOICE.hint}</span>
              </span>
            </button>
            <button type="button" onClick={() => update(enterManually)} className={CHOICE_BUTTON}>
              <span className="text-2xl" aria-hidden="true">✍️</span>
              <span>
                <span className="block font-medium text-[var(--text-primary)]">{ENTER_YOURSELF_CHOICE.label}</span>
                <span className="block text-sm text-[var(--text-secondary)]">{ENTER_YOURSELF_CHOICE.hint}</span>
              </span>
            </button>
          </div>
        )}

        {!blockedMessage && state.stage === 'choose' && (
          <div className="space-y-3">
            <input
              ref={cameraInputRef}
              type="file"
              accept={RECEIPT_ACCEPT}
              capture="environment"
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={onInputChange}
            />
            <input
              ref={libraryInputRef}
              type="file"
              accept={RECEIPT_ACCEPT}
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={onInputChange}
            />
            <button type="button" data-autofocus onClick={() => cameraInputRef.current?.click()} className={CHOICE_BUTTON}>
              <span className="text-2xl" aria-hidden="true">📷</span>
              <span className="block font-medium text-[var(--text-primary)]">Take a photo</span>
            </button>
            <button type="button" onClick={() => libraryInputRef.current?.click()} className={CHOICE_BUTTON}>
              <span className="text-2xl" aria-hidden="true">🖼️</span>
              <span className="block font-medium text-[var(--text-primary)]">Choose a photo or PDF</span>
            </button>
            <Button variant="ghost" fullWidth onClick={() => update(backToIdle)}>
              Back
            </Button>
          </div>
        )}

        {!blockedMessage && state.stage === 'reading' && (
          <div className="flex flex-col items-center justify-center py-8 gap-3">
            <Spinner size="lg" />
            <p role="status" aria-live="polite" className="text-sm text-[var(--text-secondary)]">
              {READING_COPY[substage]}
            </p>
            {state.phase === 'parsing' && parseElapsedMs > 5000 && (
              <p className="text-xs text-[var(--text-muted)] tabular-nums" aria-hidden="true">
                {Math.floor(parseElapsedMs / 1000)}s
              </p>
            )}
            <Button variant="secondary" data-autofocus onClick={handleCancel}>
              Cancel
            </Button>
          </div>
        )}

        {!blockedMessage && state.stage === 'failed' && state.failure && (
          <div className="space-y-4">
            <div
              role="alert"
              className="rounded-[var(--radius-md)] border border-warn-200 bg-warn-50 dark:bg-warn-900 dark:border-warn-800 px-3 py-2.5 text-sm text-warn-700 dark:text-warn-300"
            >
              {state.failure.message}
            </div>
            <div className="space-y-2">
              {actions.retry && (
                <Button variant="primary" fullWidth data-autofocus onClick={handleRetry} className="min-h-14">
                  Try again
                </Button>
              )}
              <Button
                variant={actions.retry ? 'secondary' : 'primary'}
                fullWidth
                data-autofocus={actions.retry ? undefined : true}
                onClick={() => update(enterManually)}
                className="min-h-14"
              >
                Enter it yourself instead
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
