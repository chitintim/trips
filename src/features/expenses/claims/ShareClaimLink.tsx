import { useState } from 'react'
import { Button, useToast } from '../../../components/ui'

/**
 * Share control for a receipt's claim link (payer / people who manage the
 * trip). Copy + the phone's own share sheet when there is one. The link stays
 * login-gated: people open it in the app where they are already signed in.
 * No QR code: the repo has no QR dependency and none is added here.
 */
export function ShareClaimLink({ code, title }: { code: string; title: string }) {
  const { showToast } = useToast()
  const [shown, setShown] = useState(false)
  const url = `${window.location.origin}/claim/${encodeURIComponent(code)}`
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      showToast({ type: 'success', message: 'Link copied' })
    } catch {
      setShown(true)
      showToast({ type: 'info', message: 'Press and hold the link to copy it' })
    }
  }

  const share = async () => {
    try {
      await navigator.share({ title, text: `What did you have? Tap your items on ${title}.`, url })
    } catch (err) {
      // Cancelling the share sheet is not an error.
      if (err instanceof DOMException && err.name === 'AbortError') return
      setShown(true)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {canShare && (
          <Button variant="secondary" size="sm" onClick={share}>
            Share claim link
          </Button>
        )}
        <Button variant={canShare ? 'ghost' : 'secondary'} size="sm" onClick={copy}>
          {canShare ? 'Copy link' : 'Share claim link (copy)'}
        </Button>
      </div>
      {shown && <p className="text-xs break-all select-all text-[var(--text-secondary)]">{url}</p>}
      <p className="text-xs text-[var(--text-muted)]">People need to be signed in to Trips to open it.</p>
    </div>
  )
}
