import { useState } from 'react'
import { Modal, Button, Input, useToast, ConfirmDiscardSheet } from '../../../components/ui'
import { supabase } from '../../../lib/supabase'
import { useUnsavedChangesGuard } from '../../../lib/forms'
import type { IngestResult, OptionDraft } from '../../../shared/contracts'

interface PasteALinkSheetProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  /** Called with the extracted option draft once the user approves it — the caller opens OptionEditorSheet pre-filled for final review/section choice. */
  onApproved: (draft: OptionDraft) => void
}

/**
 * Paste-a-link option creation (plan §7/§9): a URL goes to the shared
 * `ingest` edge function, which classifies + extracts. For "option"
 * classification specifically, the function returns the draft directly
 * (no ai_proposals row — see supabase/functions/ingest/index.ts) since
 * creating an option needs a section_id the ingest call doesn't have; we
 * show it as a review card and let the user pick a section + confirm via
 * OptionEditorSheet, which is where the actual create_option write happens
 * under their own JWT.
 *
 * The function may be unreachable in local dev (no Anthropic key
 * configured, function not served, network error) — this degrades
 * gracefully to a toast + manual entry instead of blocking the flow.
 */
export function PasteALinkSheet({ isOpen, onClose, tripId, onApproved }: PasteALinkSheetProps) {
  const { showToast } = useToast()
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<OptionDraft | null>(null)
  const [nonOptionWarning, setNonOptionWarning] = useState<string | null>(null)

  const reset = () => {
    setUrl('')
    setLoading(false)
    setError(null)
    setPreview(null)
    setNonOptionWarning(null)
  }

  const closeAndReset = () => {
    reset()
    onClose()
  }

  const isDirty = url.trim().length > 0
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isDirty)
  const handleClose = () => confirmClose(closeAndReset)

  const handleFetch = async () => {
    if (!url.trim()) return
    setLoading(true)
    setError(null)
    setPreview(null)
    setNonOptionWarning(null)

    try {
      const { data, error: invokeError } = await supabase.functions.invoke('ingest', {
        body: { trip_id: tripId, url: url.trim() },
      })

      if (invokeError) throw invokeError
      if (!data?.success) throw new Error(data?.error || 'Extraction failed')

      const result = data.result as IngestResult
      if (result.classification === 'option') {
        setPreview(result.option)
      } else {
        setNonOptionWarning(
          `This looks like a ${result.classification}, not an option to compare. Try the dedicated "${result.classification}" quick-add instead, or enter it manually.`
        )
      }
    } catch (err) {
      setError('Could not reach the extraction service. You can still add this option manually.')
      showToast({
        type: 'warning',
        message: 'Link extraction unavailable',
        description: 'Falling back to manual entry.',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleApprove = () => {
    if (!preview) return
    onApproved(preview)
    reset()
  }

  const handleManualFallback = () => {
    onApproved({ title: '', description: null, price: null, currency: null, price_type: null, place_name: null, place_url: url || null, image_url: null })
    reset()
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="md" title="Add from a link">
      <div className="space-y-4">
        <p className="text-sm text-[var(--text-secondary)]">
          Paste an Airbnb, Booking.com, restaurant, or Google Maps link — we'll try to pull out the title, price, and
          location for you to review.
        </p>

        <div className="flex gap-2">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." fullWidth autoFocus />
          <Button onClick={handleFetch} isLoading={loading} disabled={!url.trim()}>
            Fetch
          </Button>
        </div>

        {error && (
          <div className="bg-warn-50 border border-warn-200 text-warn-800 rounded-[var(--radius-md)] p-3 text-sm flex items-center justify-between gap-3">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={handleManualFallback}>
              Enter manually
            </Button>
          </div>
        )}

        {nonOptionWarning && (
          <div className="bg-warn-50 border border-warn-200 text-warn-800 rounded-[var(--radius-md)] p-3 text-sm">
            {nonOptionWarning}
          </div>
        )}

        {preview && (
          <div className="border border-[var(--border-default)] rounded-[var(--radius-md)] p-4 space-y-2">
            <p className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Review before adding</p>
            <p className="font-semibold text-[var(--text-primary)]">{preview.title}</p>
            {preview.description && <p className="text-sm text-[var(--text-secondary)]">{preview.description}</p>}
            {preview.price != null && (
              <p className="text-sm text-[var(--text-primary)]">
                {preview.currency || ''} {preview.price}
              </p>
            )}
            {preview.place_name && <p className="text-xs text-[var(--text-muted)]">📍 {preview.place_name}</p>}
            <div className="flex justify-end pt-2">
              <Button onClick={handleApprove}>Approve & continue</Button>
            </div>
          </div>
        )}

        <div className="flex justify-end pt-2">
          <Button variant="outline" onClick={handleClose}>
            {preview ? 'Cancel' : 'Close'}
          </Button>
        </div>
      </div>

      <ConfirmDiscardSheet isOpen={guardProps.showConfirm} onKeep={guardProps.onKeep} onDiscard={guardProps.onDiscard} />
    </Modal>
  )
}
