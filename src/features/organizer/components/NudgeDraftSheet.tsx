import { useEffect, useRef, useState } from 'react'
import { Modal, Button, TextArea, Spinner, useToast } from '../../../components/ui'
import { requestNudgeDraft, NudgeQuotaError } from '../lib/nudgeClient'
import { useTripActivityLog } from '../lib/activity'
import type { Blocker } from '../lib/blockers'

export interface NudgeDraftSheetProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  targetUserId: string
  targetName: string
  blocker: Blocker
}

/**
 * One-tap nudge composer (plan §14): calls the nudge-draft edge function
 * for an AI draft, lets the organizer edit it, then copies it (deep link
 * included) to the clipboard for WhatsApp. If the AI is unavailable or the
 * quota is spent, degrades to a blank editable draft with the trip deep
 * link so the organizer can still nudge by hand.
 */
export function NudgeDraftSheet({ isOpen, onClose, tripId, targetUserId, targetName, blocker }: NudgeDraftSheetProps) {
  const { showToast } = useToast()
  const logActivity = useTripActivityLog(tripId)
  const [message, setMessage] = useState('')
  const [deepLink, setDeepLink] = useState('')
  const [loading, setLoading] = useState(false)
  const [aiNote, setAiNote] = useState<string | null>(null)
  const requestedFor = useRef<string | null>(null)

  useEffect(() => {
    if (!isOpen) {
      requestedFor.current = null
      return
    }
    const requestKey = `${targetUserId}:${blocker.kind}:${blocker.entityId ?? ''}`
    if (requestedFor.current === requestKey) return
    requestedFor.current = requestKey

    const fallbackLink = `${window.location.origin}${import.meta.env.BASE_URL ?? '/'}`.replace(/\/$/, '') + `/${tripId}`
    setMessage('')
    setDeepLink(fallbackLink)
    setAiNote(null)

    if (!blocker.nudgeType) {
      setMessage(`Hey ${targetName.split(' ')[0]}! ${blocker.detail ?? blocker.label} ${fallbackLink}`)
      setAiNote('No AI draft for this blocker type — edit freely.')
      return
    }

    setLoading(true)
    requestNudgeDraft({
      trip_id: tripId,
      target_user_id: targetUserId,
      blocker_type: blocker.nudgeType,
      blocker_entity_id: blocker.entityId,
    })
      .then((draft) => {
        setMessage(draft.message)
        setDeepLink(draft.deep_link)
      })
      .catch((err) => {
        setAiNote(
          err instanceof NudgeQuotaError
            ? 'Daily AI quota reached — write it yourself, the deep link still works.'
            : `AI draft unavailable (${(err as Error).message}) — write it yourself.`
        )
        setMessage(`Hey ${targetName.split(' ')[0]}! ${blocker.detail ?? blocker.label} ${fallbackLink}`)
      })
      .finally(() => setLoading(false))
  }, [isOpen, tripId, targetUserId, targetName, blocker])

  const handleCopy = async () => {
    const text = message.includes(deepLink) || !deepLink ? message : `${message.trimEnd()} ${deepLink}`
    try {
      await navigator.clipboard.writeText(text)
      showToast({ type: 'success', message: 'Copied — paste it into WhatsApp' })
      logActivity({
        verb: 'nudge_drafted',
        entity: { type: 'user', id: targetUserId, label: targetName },
        metadata: { blocker_kind: blocker.kind, entity_id: blocker.entityId ?? null },
      })
      onClose()
    } catch {
      showToast({ type: 'error', message: 'Could not copy to clipboard', description: 'Select and copy the text manually.' })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md" title={`Nudge ${targetName}`}>
      <div className="space-y-4">
        <div className="rounded-[var(--radius-md)] bg-[var(--surface-sunken)] px-3 py-2 text-sm text-[var(--text-secondary)]">
          {blocker.detail ?? blocker.label}
        </div>

        {loading ? (
          <div className="flex items-center gap-3 py-6 justify-center text-[var(--text-muted)]">
            <Spinner size="sm" /> Drafting a friendly message…
          </div>
        ) : (
          <>
            {aiNote && <p className="text-xs text-[var(--text-muted)]">{aiNote}</p>}
            <TextArea
              label="Message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={5}
              helperText="Edit freely — the deep link takes them straight to the action."
            />
            {deepLink && (
              <p className="text-xs text-[var(--text-muted)] break-all">
                Deep link: <span className="font-mono">{deepLink}</span>
              </p>
            )}
          </>
        )}

        <div className="flex justify-end gap-3 pt-2 border-t border-[var(--border-subtle)]">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleCopy} disabled={loading || !message.trim()} leftIcon={<span>📋</span>}>
            Copy for WhatsApp
          </Button>
        </div>
      </div>
    </Modal>
  )
}
