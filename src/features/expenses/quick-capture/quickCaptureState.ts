/**
 * Quick capture state machine (plan §10 #1, the flagship flow): photo/file
 * -> upload -> parse-receipt -> confirmation card -> save in <=3 taps, with
 * "Refine later" opening the full editor and graceful manual entry on
 * parse failure.
 */
import type { ParsedReceiptData } from '../../../lib/receiptParsing'

export type QuickCaptureStage =
  | 'pick' // choose photo/file
  | 'uploading'
  | 'parsing'
  | 'confirm' // "does this look right?" card
  | 'manual' // parse failed -- manual entry with photo attached
  | 'saving'
  | 'done'

export interface QuickCaptureState {
  stage: QuickCaptureStage
  file: File | null
  receiptPath: string | null
  parsed: ParsedReceiptData | null
  parseError: string | null
  // Confirmation card editable fields (smart defaults applied on parse success)
  vendor: string
  total: string
  currency: string
  date: string
  category: string
}

export function initialQuickCaptureState(today: string): QuickCaptureState {
  return {
    stage: 'pick',
    file: null,
    receiptPath: null,
    parsed: null,
    parseError: null,
    vendor: '',
    total: '',
    currency: 'GBP',
    date: today,
    category: 'food',
  }
}

/** Maps a successful parse result into the confirmation card's editable fields. */
export function applyParseResult(state: QuickCaptureState, parsed: ParsedReceiptData, today: string): QuickCaptureState {
  return {
    ...state,
    stage: 'confirm',
    parsed,
    parseError: null,
    vendor: parsed.vendor_name || '',
    total: String(parsed.total),
    currency: parsed.currency || 'GBP',
    date: parsed.receipt_date || today,
    category: parsed.expense_category || 'food',
  }
}
