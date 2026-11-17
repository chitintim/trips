import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { AiCallError } from '../_shared/aiError.ts'
import { checkReceiptFile, countPdfPages, MAX_IMAGE_BYTES, MAX_PDF_BYTES, MAX_PDF_PAGES, sniffMediaType, toBase64 } from './fileType.ts'

const bytes = (head: number[], total = head.length) => {
  const b = new Uint8Array(total)
  b.set(head)
  return b
}
const JPEG = [0xff, 0xd8, 0xff, 0xe0]
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PDF = [...'%PDF-1.7'].map((c) => c.charCodeAt(0))
const WEBP = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]
const HEIC = [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63] // ftypheic

Deno.test('sniffs types from magic bytes', () => {
  assertEquals(sniffMediaType(bytes(JPEG)), 'image/jpeg')
  assertEquals(sniffMediaType(bytes(PNG)), 'image/png')
  assertEquals(sniffMediaType(bytes(PDF)), 'application/pdf')
  assertEquals(sniffMediaType(bytes(WEBP)), 'image/webp')
  assertEquals(sniffMediaType(bytes(HEIC)), null)
})

Deno.test('magic bytes win over a wrong declared type or extension', () => {
  assertEquals(checkReceiptFile(bytes(PNG), 'image/jpeg', 'u/r.jpg'), 'image/png')
})

Deno.test('HEIC and unknown bytes are unsupported_type', () => {
  const e = assertThrows(() => checkReceiptFile(bytes(HEIC), 'image/heic', 'u/r.heic'), AiCallError)
  assertEquals([e.code, e.status], ['unsupported_type', 415])
  assertThrows(() => checkReceiptFile(bytes([1, 2, 3, 4]), 'application/octet-stream', 'u/r.bin'), AiCallError)
})

Deno.test('image cap keeps the BASE64 text under the API 5 MB per-image limit', () => {
  assertEquals(MAX_IMAGE_BYTES, 3_600_000)
  assert(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 <= 5_000_000)
  // the old 5 MiB raw cap would have been ~7 MB of base64
  const e = assertThrows(() => checkReceiptFile(bytes(JPEG, 4_200_000), 'image/jpeg', 'a.jpg'), AiCallError)
  assertEquals([e.code, e.status], ['too_large', 413])
  assert(e.message.includes('too big'))
})

Deno.test('PDF page count: /Type /Page counted, /Pages not; over the cap is too_large', () => {
  const enc = (s: string) => new TextEncoder().encode(s)
  const pdf = (n: number) => enc('%PDF-1.7\n1 0 obj<</Type /Pages /Count ' + n + '>>endobj\n' + Array.from({ length: n }, (_, i) => `${i + 2} 0 obj<</Type/Page/Parent 1 0 R>>endobj`).join('\n'))
  assertEquals(countPdfPages(pdf(3)), 3)
  assertEquals(checkReceiptFile(pdf(MAX_PDF_PAGES), 'application/pdf', 'a.pdf'), 'application/pdf')
  const e = assertThrows(() => checkReceiptFile(pdf(MAX_PDF_PAGES + 1), 'application/pdf', 'a.pdf'), AiCallError)
  assertEquals(e.code, 'too_large')
})

Deno.test('size caps: images 3.6 MB, PDFs 10 MB', () => {
  assertEquals(checkReceiptFile(bytes(JPEG, MAX_IMAGE_BYTES), 'image/jpeg', 'a.jpg'), 'image/jpeg')
  const tooBigImage = assertThrows(() => checkReceiptFile(bytes(JPEG, MAX_IMAGE_BYTES + 1), 'image/jpeg', 'a.jpg'), AiCallError)
  assertEquals([tooBigImage.code, tooBigImage.status], ['too_large', 413])
  assertEquals(checkReceiptFile(bytes(PDF, 9 * 1024 * 1024), 'application/pdf', 'a.pdf'), 'application/pdf')
  assertEquals(checkReceiptFile(bytes(PDF, MAX_PDF_BYTES), 'application/pdf', 'a.pdf'), 'application/pdf')
  assertThrows(() => checkReceiptFile(bytes(PDF, MAX_PDF_BYTES + 1), 'application/pdf', 'a.pdf'), AiCallError)
})

Deno.test('toBase64 round-trips large buffers', () => {
  const b = new Uint8Array(100_000).map((_, i) => i % 251)
  const back = Uint8Array.from(atob(toBase64(b)), (c) => c.charCodeAt(0))
  assertEquals(back.length, b.length)
  assertEquals(back[99_999], b[99_999])
})
