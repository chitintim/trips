import { describe, it, expect, vi } from 'vitest'

vi.mock('./supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }))

import {
  buildReceiptParseError,
  ReceiptParseError,
  RECEIPT_MAX_PDF_BYTES,
  type ReceiptParseErrorCode,
} from './receiptParsing'

describe('buildReceiptParseError', () => {
  it('maps coded errors to plain copy and ignores the server message', () => {
    const e = buildReceiptParseError({ error: 'server text', code: 'busy' }, 503, 'fb')
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(ReceiptParseError)
    expect(e.code).toBe('busy')
    expect(e.status).toBe(503)
    expect(e.message).toBe('The scanner is busy right now. Please try again in a minute.')
  })

  it.each([
    ['rate_limited', true],
    ['busy', true],
    ['unknown', true],
    ['unreadable', false],
    ['too_large', false],
    ['unsupported_type', false],
    ['refused', false],
  ] as Array<[ReceiptParseErrorCode, boolean]>)('%s retryable=%s', (code, retryable) => {
    const e = buildReceiptParseError({ code }, 400, 'fb')
    expect(e.code).toBe(code)
    expect(e.retryable).toBe(retryable)
    expect(e.message.length).toBeGreaterThan(10)
  })

  it('keeps the old behaviour when there is no code', () => {
    const e = buildReceiptParseError({ error: 'Old server says no' }, 500, 'fallback')
    expect(e.message).toBe('Old server says no')
    expect(e.code).toBeUndefined()
    expect(e.retryable).toBe(false)
    expect(buildReceiptParseError({}, 500, 'fallback').message).toBe('fallback')
    expect(buildReceiptParseError(null, 500, 'fallback').message).toBe('fallback')
  })

  it('treats unknown code strings like the old shape', () => {
    const e = buildReceiptParseError({ error: 'x', code: 'toString' }, 500, 'fb')
    expect(e.message).toBe('x')
    expect(e.code).toBeUndefined()
  })
})

describe('PDF limit', () => {
  it('matches the server 10 MB limit', () => {
    expect(RECEIPT_MAX_PDF_BYTES).toBe(10 * 1024 * 1024)
  })
  it('too_large copy mentions the limit', () => {
    expect(buildReceiptParseError({ code: 'too_large' }, 413, '').message).toContain('10 MB')
  })
})

import { describeScanFailure, isReceiptScanCancelled, RECEIPT_SCAN_TIMEOUT_MS } from './receiptParsing'

describe('describeScanFailure', () => {
  it('uses the coded message and retryable flag', () => {
    const e = buildReceiptParseError({ code: 'busy' }, 503, 'fb')
    expect(describeScanFailure(e)).toEqual({ message: e.message, retryable: true, code: 'busy' })
    const u = buildReceiptParseError({ code: 'unreadable' }, 422, 'fb')
    expect(describeScanFailure(u)).toMatchObject({ retryable: false, code: 'unreadable' })
  })
  it('maps fetch failures to the network copy', () => {
    expect(describeScanFailure(new TypeError('Failed to fetch'))).toEqual({
      message: "We couldn't reach the scanner. Check your connection and try again.",
      retryable: true,
      code: 'network',
    })
  })
  it('never leaks raw text for uncoded or unknown errors', () => {
    const raw = buildReceiptParseError({ error: 'ANTHROPIC 529 stack trace' }, 500, 'fb')
    const d = describeScanFailure(raw)
    expect(d.message).not.toContain('ANTHROPIC')
    expect(d.code).toBe('unknown')
    expect(describeScanFailure(new Error('secret internals')).message).not.toContain('secret')
    expect(describeScanFailure('weird').code).toBe('unknown')
  })
  it('recognises aborts and has a 115 s client timeout', () => {
    const abort = new DOMException('aborted', 'AbortError')
    expect(isReceiptScanCancelled(abort)).toBe(true)
    expect(isReceiptScanCancelled(new Error('x'))).toBe(false)
    expect(describeScanFailure(abort).code).toBe('timeout')
    expect(RECEIPT_SCAN_TIMEOUT_MS).toBe(115_000)
  })
})
