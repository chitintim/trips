import { describe, it, expect, vi } from 'vitest'

vi.mock('./supabase', () => ({ supabase: {} }))

import { checkReceiptFile, isPdfFile, RECEIPT_ACCEPT } from './receiptUpload'

const MB = 1024 * 1024
const f = (name: string, type: string, size: number) => ({ name, type, size })

describe('checkReceiptFile', () => {
  it('accepts normal photos and PDFs', () => {
    expect(checkReceiptFile(f('a.jpg', 'image/jpeg', 2 * MB))).toEqual({ ok: true })
    expect(checkReceiptFile(f('a.heic', 'image/heic', 8 * MB))).toEqual({ ok: true })
    expect(checkReceiptFile(f('a.pdf', 'application/pdf', 9 * MB))).toEqual({ ok: true })
  })
  it('allows images up to 15 MB and rejects above', () => {
    expect(checkReceiptFile(f('a.png', 'image/png', 15 * MB)).ok).toBe(true)
    const r = checkReceiptFile(f('a.png', 'image/png', 15 * MB + 1))
    expect(r.ok).toBe(false)
  })
  it('allows PDFs up to 10 MB and rejects above', () => {
    expect(checkReceiptFile(f('a.pdf', 'application/pdf', 10 * MB)).ok).toBe(true)
    const r = checkReceiptFile(f('a.pdf', 'application/pdf', 10 * MB + 1))
    expect(r).toMatchObject({ ok: false })
    if (!r.ok) expect(r.message).toContain('PDF')
  })
  it('treats a PDF by extension when the type is empty', () => {
    expect(checkReceiptFile(f('Receipt.PDF', '', 11 * MB)).ok).toBe(false)
    expect(checkReceiptFile(f('Receipt.PDF', '', 1 * MB)).ok).toBe(true)
  })
  it('rejects unsupported types and empty files', () => {
    expect(checkReceiptFile(f('a.txt', 'text/plain', 100)).ok).toBe(false)
    expect(checkReceiptFile(f('noext', '', 100)).ok).toBe(false)
    expect(checkReceiptFile(f('a.jpg', 'image/jpeg', 0)).ok).toBe(false)
  })
  it('gives plain messages with no technical detail', () => {
    const r = checkReceiptFile(f('a.jpg', 'image/jpeg', 20 * MB))
    if (!r.ok) expect(r.message).not.toMatch(/bytes|Error|undefined/)
  })
})

describe('one PDF test and one accept list', () => {
  it('isPdfFile counts a type or an extension', () => {
    expect(isPdfFile({ name: 'a.pdf', type: 'application/pdf' })).toBe(true)
    expect(isPdfFile({ name: 'Receipt.PDF', type: '' })).toBe(true)
    expect(isPdfFile({ name: 'scan', type: 'application/pdf' })).toBe(true)
    expect(isPdfFile({ name: 'a.jpg', type: 'image/jpeg' })).toBe(false)
    expect(isPdfFile({ name: 'pdf', type: '' })).toBe(false)
  })
  it('the file pickers accept everything checkReceiptFile accepts', () => {
    const accepted = RECEIPT_ACCEPT.split(',')
    for (const type of ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'image/gif', 'application/pdf']) {
      expect(accepted).toContain(type)
      expect(checkReceiptFile(f('x', type, 1000)).ok).toBe(true)
    }
  })
})
