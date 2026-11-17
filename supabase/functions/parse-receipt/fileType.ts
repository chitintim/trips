// Receipt file type + size rules for parse-receipt.

import { AiCallError } from '../_shared/aiError.ts'

/**
 * Raw image cap. The API's per-image limit is 5 MB and is applied to the
 * BASE64 text (base64 is 4/3 of the raw size), so the raw cap is
 * floor(5_000_000 * 3/4) = 3_750_000 less a safety margin = 3_600_000
 * (base64 of that = 4_800_000). Using decimal MB is deliberately the stricter
 * reading of "5 MB" (5 MiB would allow 3_932_160 raw). The client compresses
 * receipt photos to ~0.5 MB and caps the final file at 3 MiB (src/lib/receiptUpload.ts),
 * which is below this, so normal uploads never hit it.
 */
export const MAX_IMAGE_BYTES = 3_600_000
/** Largest raw image, in MB as shown to people. */
export const MAX_IMAGE_MB_LABEL = '3.5 MB'
/**
 * Page cap for PDFs. The API allows 600 pages on 1M-context models but 100 on
 * 200k-context models, and CLAUDE_MODEL_PARSE_RECEIPT can be pointed at either,
 * so use the smaller. No receipt is longer.
 */
export const MAX_PDF_PAGES = 100
/**
 * PDFs may be larger: the API accepts 32 MB per request (600 pages on 1M-context
 * models) and base64 adds ~37%, so 10 MB of PDF is ~13.7 MB on the wire.
 */
export const MAX_PDF_BYTES = 10 * 1024 * 1024

const TOO_LARGE_IMAGE_MESSAGE = `This photo is too big to scan (over ${MAX_IMAGE_MB_LABEL}). Try a smaller photo or a screenshot, or enter it yourself.`
const TOO_LARGE_PDF_MESSAGE = 'This PDF is too large to scan (over 10 MB or more than 100 pages). Try a smaller or shorter PDF, or enter it yourself.'

export type ReceiptMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'application/pdf'

const EXT_TYPES: Record<string, ReceiptMediaType> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
}

/** Sniffs the real type from magic bytes; null when unrecognised. */
export function sniffMediaType(b: Uint8Array): ReceiptMediaType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  // %PDF may be preceded by a few junk bytes in the wild; accept within the first 1 KB.
  const head = String.fromCharCode(...b.subarray(0, Math.min(b.length, 1024)))
  if (head.includes('%PDF-')) return 'application/pdf'
  return null
}

/**
 * Decides the media type (magic bytes win over the declared type and the
 * extension) and enforces the size cap for it. Throws coded errors:
 * 'unsupported_type' (e.g. HEIC, which the client converts first) or 'too_large'.
 */
export function checkReceiptFile(bytes: Uint8Array, declaredType: string | null | undefined, path: string): ReceiptMediaType {
  const sniffed = sniffMediaType(bytes)
  let type: ReceiptMediaType | null = sniffed
  if (!type) {
    const ext = path.toLowerCase().split('.').pop() ?? ''
    const declared = (declaredType ?? '').toLowerCase()
    type = EXT_TYPES[ext] ?? (Object.values(EXT_TYPES).includes(declared as ReceiptMediaType) ? (declared as ReceiptMediaType) : null)
    // Unrecognised bytes with a supported-looking name: let the model try only
    // when nothing says otherwise; an empty file is never a receipt.
    if (type && bytes.length === 0) type = null
  }
  if (!type) throw new AiCallError('unsupported_type', `type ${declaredType ?? 'unknown'}`)
  const isPdf = type === 'application/pdf'
  const cap = isPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES
  if (bytes.length > cap) {
    throw new AiCallError('too_large', `${bytes.length} bytes > ${cap}`, isPdf ? TOO_LARGE_PDF_MESSAGE : TOO_LARGE_IMAGE_MESSAGE)
  }
  if (isPdf) {
    const pages = countPdfPages(bytes)
    if (pages > MAX_PDF_PAGES) throw new AiCallError('too_large', `${pages} pages > ${MAX_PDF_PAGES}`, TOO_LARGE_PDF_MESSAGE)
  }
  return type
}

/**
 * Cheap page count: occurrences of `/Type /Page` (not `/Pages`) in the raw
 * bytes. Best effort: PDFs that keep page objects inside compressed object
 * streams count as 0 and are left to the API, whose "too many pages" 400 is
 * mapped to the coded too_large. Never overcounts a normal receipt.
 */
export function countPdfPages(bytes: Uint8Array): number {
  const text = new TextDecoder('latin1').decode(bytes)
  const m = text.match(/\/Type\s*\/Page(?![A-Za-z])/g)
  return m ? m.length : 0
}

/** Chunked base64 (avoids huge argument lists and quadratic string growth). */
export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunk)))
  }
  return btoa(parts.join(''))
}
