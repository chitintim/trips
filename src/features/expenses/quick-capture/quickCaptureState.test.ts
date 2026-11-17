import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../lib/supabase', () => ({ supabase: {} }))

import { buildReceiptParseError, describeScanFailure, type ParsedReceiptData, type ReceiptParseErrorCode } from '../../../lib/receiptParsing'
import {
  initialQuickCaptureState, chooseScan, backToIdle, startScan, uploaded, uploadFailed, parseSucceeded, parseFailed,
  timedOut, cancel, retry, enterManually, failureActions, readingSubstage, showsEditor, CHECKING_LABEL_AFTER_MS,
  type QuickCaptureState,
} from './quickCaptureState'

const parsed = { vendor_name: 'Cafe', total: 12, currency: 'EUR' } as unknown as ParsedReceiptData

const reading = (): QuickCaptureState => startScan(chooseScan(initialQuickCaptureState()))
const parsing = (): QuickCaptureState => uploaded(reading(), 1, 'u/r.jpg')

describe('quick capture state machine', () => {
  it('starts idle, moves to choose and back', () => {
    const s = initialQuickCaptureState()
    expect(s.stage).toBe('idle')
    expect(chooseScan(s).stage).toBe('choose')
    expect(backToIdle(chooseScan(s)).stage).toBe('idle')
    expect(startScan(s).stage).toBe('idle') // cannot start without choosing
  })

  it('reading derives uploading -> reading -> checking from elapsed time', () => {
    const r = reading()
    expect(r.stage).toBe('reading')
    expect(readingSubstage(r, 0)).toBe('uploading')
    const p = uploaded(r, r.runId, 'u/r.jpg')
    expect(p.receiptPath).toBe('u/r.jpg')
    expect(readingSubstage(p, 0)).toBe('reading')
    expect(readingSubstage(p, CHECKING_LABEL_AFTER_MS - 1)).toBe('reading')
    expect(readingSubstage(p, CHECKING_LABEL_AFTER_MS)).toBe('checking')
  })

  it('success carries the parse and opens the form', () => {
    const s = parseSucceeded(parsing(), 1, parsed)
    expect(s.stage).toBe('success')
    expect(s.parsed).toBe(parsed)
    expect(showsEditor(s)).toBe(true)
  })

  const codes: ReceiptParseErrorCode[] = ['unreadable', 'too_large', 'unsupported_type', 'rate_limited', 'busy', 'refused', 'unknown']
  const retryable: Record<string, boolean> = { rate_limited: true, busy: true, unknown: true }
  for (const code of codes) {
    it(`failure ${code}: plain message, keeps the photo, always offers Enter it yourself`, () => {
      const f = describeScanFailure(buildReceiptParseError({ code, error: 'raw server text' }, 500, 'fb'))
      const s = parseFailed(parsing(), 1, f)
      expect(s.stage).toBe('failed')
      expect(s.failure?.code).toBe(code)
      expect(s.failure?.message).toBeTruthy()
      // too_large deliberately keeps the server's own user-safe sentence
      if (code !== 'too_large') expect(s.failure?.message).not.toContain('raw server text')
      expect(s.receiptPath).toBe('u/r.jpg')
      expect(failureActions(s)).toEqual({ retry: !!retryable[code], enterYourself: true })
      const m = enterManually(s)
      expect(m.stage).toBe('manual')
      expect(m.receiptPath).toBe('u/r.jpg')
      expect(m.parsed).toBeNull()
    })
  }

  it('timeout failure is retryable and keeps the photo', () => {
    const s = timedOut(parsing(), 1)
    expect(s.failure).toMatchObject({ code: 'timeout', retryable: true })
    expect(s.failure?.message).toBe('That took too long. Try again, or enter it yourself: your photo is kept.')
    expect(s.receiptPath).toBe('u/r.jpg')
    expect(failureActions(s).retry).toBe(true)
  })

  it('network failure is retryable', () => {
    const s = parseFailed(parsing(), 1, describeScanFailure(new TypeError('Failed to fetch')))
    expect(s.failure).toMatchObject({ code: 'network', retryable: true })
    expect(failureActions(s).retry).toBe(true)
  })

  it('upload failure has no receiptPath; retry re-uploads', () => {
    const f = uploadFailed(reading(), 1, { message: "We couldn't upload the photo. Check your connection and try again.", retryable: true })
    expect(f.failure?.code).toBe('upload')
    expect(f.receiptPath).toBeNull()
    const r = retry(f)
    expect(r.stage).toBe('reading')
    expect(r.phase).toBe('uploading')
    expect(enterManually(f).receiptPath).toBeNull()
  })

  it('a non-retryable upload failure offers no retry', () => {
    const f = uploadFailed(reading(), 1, { message: 'too big', retryable: false })
    expect(failureActions(f)).toEqual({ retry: false, enterYourself: true })
    expect(retry(f)).toBe(f)
  })

  it('retry re-runs the scan from the uploaded photo and only when retryable', () => {
    const busy = parseFailed(parsing(), 1, describeScanFailure(buildReceiptParseError({ code: 'busy' }, 503, 'fb')))
    const r = retry(busy)
    expect(r.stage).toBe('reading')
    expect(r.phase).toBe('parsing')
    expect(r.receiptPath).toBe('u/r.jpg')
    expect(r.runId).toBe(busy.runId + 1)
    const unreadable = parseFailed(parsing(), 1, describeScanFailure(buildReceiptParseError({ code: 'unreadable' }, 422, 'fb')))
    expect(retry(unreadable)).toBe(unreadable)
  })

  it('cancel returns to choose and ignores late results', () => {
    const p = parsing()
    const c = cancel(p)
    expect(c.stage).toBe('choose')
    expect(c.receiptPath).toBeNull()
    expect(parseSucceeded(c, 1, parsed)).toBe(c)
    expect(parseFailed(c, 1, describeScanFailure(new Error('x')))).toBe(c)
    expect(uploaded(c, 1, 'late.jpg')).toBe(c)
    expect(timedOut(c, 1)).toBe(c)
  })

  it('a late result from an old run is ignored after retry', () => {
    const busy = parseFailed(parsing(), 1, describeScanFailure(buildReceiptParseError({ code: 'busy' }, 503, 'fb')))
    const r = retry(busy)
    expect(parseSucceeded(r, 1, parsed)).toBe(r)
    expect(parseSucceeded(r, 2, parsed).stage).toBe('success')
  })

  it('a result after the timeout fired is ignored', () => {
    const t = timedOut(parsing(), 1)
    expect(parseSucceeded(t, 1, parsed)).toBe(t)
  })

  it('Enter it yourself from idle opens a blank form', () => {
    const m = enterManually(initialQuickCaptureState())
    expect(m.stage).toBe('manual')
    expect(showsEditor(m)).toBe(true)
    expect(m.receiptPath).toBeNull()
  })
})
