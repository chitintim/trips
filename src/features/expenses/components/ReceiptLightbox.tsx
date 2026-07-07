import { useEffect, useState } from 'react'
import { Modal, Button } from '../../../components/ui'
import { getReceiptUrl } from '../../../lib/receiptUpload'

export interface ReceiptLightboxProps {
  /** Storage path (expenses.receipt_url), NOT a signed URL -- this component fetches its own via getReceiptUrl. */
  path: string
  title?: string
  onClose: () => void
}

/**
 * Full-screen receipt preview + download, shared across every surface a
 * receipt can appear (expense card, editor, claim page, my-spending
 * gallery) so there's exactly one lightbox implementation instead of N
 * near-duplicates. Handles PDFs (via iframe) as well as images.
 *
 * Download uses fetch->blob->object-URL rather than a plain `<a download>`
 * pointed at the signed URL directly: Supabase signed URLs are
 * cross-origin from the app's own domain, and a handful of browsers
 * (notably Safari) ignore the `download` attribute on cross-origin links
 * and just navigate/open the file instead of saving it. Fetching the
 * bytes and creating a same-origin `blob:` URL makes `download` reliable
 * everywhere; if the fetch itself fails (e.g. CORS misconfiguration on the
 * bucket), it falls back to opening the signed URL in a new tab so the
 * user can still get the file via the browser's own save dialog.
 */
export function ReceiptLightbox({ path, title, onClose }: ReceiptLightboxProps) {
  const [url, setUrl] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setUrl(null)
    getReceiptUrl(path)
      .then((u) => !cancelled && setUrl(u))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [path])

  const isPdf = /\.pdf(\?|$)/i.test(path)
  const fileName = path.split('/').pop() || 'receipt'

  const handleDownload = async () => {
    if (!url) return
    setDownloading(true)
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`fetch failed: ${response.status}`)
      const blob = await response.blob()
      const blobUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = blobUrl
      link.download = fileName
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(blobUrl)
    } catch {
      window.open(url, '_blank', 'noopener')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={title || 'Receipt'} size="lg">
      <div className="space-y-3">
        {url ? (
          isPdf ? (
            <iframe
              src={url}
              title={title || 'Receipt'}
              className="w-full h-[70vh] rounded-[var(--radius-md)] border border-[var(--border-subtle)]"
            />
          ) : (
            <img src={url} alt={title || 'Receipt'} className="w-full h-auto rounded-[var(--radius-md)]" />
          )
        ) : (
          <div className="aspect-square animate-pulse bg-[var(--surface-sunken)] rounded-[var(--radius-md)]" />
        )}
        <Button variant="secondary" size="sm" onClick={handleDownload} disabled={!url} isLoading={downloading}>
          Download
        </Button>
      </div>
    </Modal>
  )
}
