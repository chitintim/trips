/**
 * Quick capture state machine (pure). The scan flow:
 *
 *   idle -> choose -> reading(uploading -> reading -> checking) -> success
 *                         |                \-> failed (retry | enter it yourself)
 *                         \-> cancel -> choose
 *
 * `success` and `manual` both open the one-screen expense form; `success` is
 * pre-filled with the parse, `manual` is blank (a failed scan keeps the photo
 * via `receiptPath`). Every async step carries the `runId` it started with;
 * results for any other run (cancelled, timed out, superseded) are ignored.
 */
import type { ParsedReceiptData, ReceiptScanFailureCode, ScanFailure } from '../../../lib/receiptParsing'

export type { ReceiptScanFailureCode, ScanFailure }
/** Codes a failed scan can carry: server codes plus client-only timeout / network, and a failed upload. */
export type QuickCaptureFailureCode = ReceiptScanFailureCode | 'upload'

export type QuickCaptureStage =
  | 'idle' // Scan a receipt / Enter it yourself
  | 'choose' // Take a photo / Choose a photo or PDF
  | 'reading'
  | 'success' // form opens pre-filled
  | 'failed'
  | 'manual' // form opens blank (photo kept when there is one)

export type ReadingPhase = 'uploading' | 'parsing'
export type ReadingSubstage = 'uploading' | 'reading' | 'checking'

export interface QuickCaptureFailure {
  code: QuickCaptureFailureCode
  message: string
  retryable: boolean
}

export interface QuickCaptureState {
  stage: QuickCaptureStage
  /** Bumped on every start, retry and cancel so stale async results can be recognised. */
  runId: number
  phase: ReadingPhase
  receiptPath: string | null
  parsed: ParsedReceiptData | null
  failure: QuickCaptureFailure | null
}

/** After this long in the parsing phase the label moves from "Reading" to "Checking the totals". */
export const CHECKING_LABEL_AFTER_MS = 6000

export const READING_COPY: Record<ReadingSubstage, string> = {
  uploading: 'Uploading the photo…',
  reading: 'Reading the receipt…',
  checking: 'Checking the totals…',
}

export function initialQuickCaptureState(): QuickCaptureState {
  return { stage: 'idle', runId: 0, phase: 'uploading', receiptPath: null, parsed: null, failure: null }
}

/** Which of the three progress labels to show. */
export function readingSubstage(state: Pick<QuickCaptureState, 'phase'>, parseElapsedMs: number): ReadingSubstage {
  if (state.phase === 'uploading') return 'uploading'
  return parseElapsedMs < CHECKING_LABEL_AFTER_MS ? 'reading' : 'checking'
}

const isCurrent = (s: QuickCaptureState, runId: number) => s.stage === 'reading' && s.runId === runId

/** "Scan a receipt" picked. */
export function chooseScan(s: QuickCaptureState): QuickCaptureState {
  return s.stage === 'idle' ? { ...s, stage: 'choose' } : s
}

/** Back from the photo buttons to the first choice. */
export function backToIdle(s: QuickCaptureState): QuickCaptureState {
  return s.stage === 'choose' ? { ...s, stage: 'idle' } : s
}

/** A file was picked: start uploading it. */
export function startScan(s: QuickCaptureState): QuickCaptureState {
  if (s.stage !== 'choose') return s
  return { ...s, stage: 'reading', runId: s.runId + 1, phase: 'uploading', receiptPath: null, parsed: null, failure: null }
}

/** The upload finished; the scanner starts. */
export function uploaded(s: QuickCaptureState, runId: number, receiptPath: string): QuickCaptureState {
  if (!isCurrent(s, runId)) return s
  return { ...s, phase: 'parsing', receiptPath }
}

export function uploadFailed(s: QuickCaptureState, runId: number, f: { message: string; retryable: boolean }): QuickCaptureState {
  if (!isCurrent(s, runId)) return s
  return { ...s, stage: 'failed', failure: { code: 'upload', message: f.message, retryable: f.retryable } }
}

export function parseSucceeded(s: QuickCaptureState, runId: number, parsed: ParsedReceiptData): QuickCaptureState {
  if (!isCurrent(s, runId)) return s
  return { ...s, stage: 'success', parsed, failure: null }
}

/** `failure` comes from describeScanFailure(err). */
export function parseFailed(s: QuickCaptureState, runId: number, failure: ScanFailure): QuickCaptureState {
  if (!isCurrent(s, runId)) return s
  return { ...s, stage: 'failed', failure: { code: failure.code, message: failure.message, retryable: failure.retryable } }
}

export const SCAN_TIMEOUT_FAILURE: ScanFailure = {
  code: 'timeout',
  message: 'That took too long. Try again, or enter it yourself: your photo is kept.',
  retryable: true,
}

/** The client-side time limit ran out. */
export function timedOut(s: QuickCaptureState, runId: number): QuickCaptureState {
  return parseFailed(s, runId, SCAN_TIMEOUT_FAILURE)
}

/** Cancel pressed: back to the photo buttons; whatever the old run returns is ignored. */
export function cancel(s: QuickCaptureState): QuickCaptureState {
  if (s.stage !== 'reading') return s
  return { ...s, stage: 'choose', runId: s.runId + 1, phase: 'uploading', receiptPath: null, parsed: null, failure: null }
}

/**
 * Try again: only when the failure is retryable. Resumes at the parsing phase
 * when the photo was already uploaded, otherwise starts over with the upload.
 */
export function retry(s: QuickCaptureState): QuickCaptureState {
  if (s.stage !== 'failed' || !s.failure?.retryable) return s
  return { ...s, stage: 'reading', runId: s.runId + 1, phase: s.receiptPath ? 'parsing' : 'uploading', failure: null }
}

/** Open the form blank. Keeps receiptPath so the photo stays attached. */
export function enterManually(s: QuickCaptureState): QuickCaptureState {
  if (s.stage !== 'idle' && s.stage !== 'failed') return s
  return { ...s, stage: 'manual', parsed: null, failure: null }
}

/** What the failure panel offers. "Enter it yourself" is always there. */
export function failureActions(s: QuickCaptureState): { retry: boolean; enterYourself: true } {
  return { retry: s.stage === 'failed' && !!s.failure?.retryable, enterYourself: true }
}

/** The form (editor wizard) is showing in these stages. */
export function showsEditor(s: QuickCaptureState): boolean {
  return s.stage === 'success' || s.stage === 'manual'
}
