import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, EmptyState, Skeleton, useToast } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'
import { useTrips } from '../lib/queries/useTrip'
import { parseAiAutonomy } from '../features/organizer/lib/aiAutonomy'
import { isEligibleForAutoApply } from '../features/chat/lib/autoApply'
import { applyAction, describeAction, parseProposalActions, saveAppliedKey, undoCreatedEntity } from '../features/chat/lib/applyProposal'
import type { ToastOptions } from '../components/ui'
import type { Json } from '../types/database.types'
import type { IngestResult } from '../shared/contracts'
import type { Trip } from '../types'

const SHARE_CACHE = 'trips-share-target-v1'
const SHARE_PAYLOAD_URL = '/trips/__share-payload__'

interface SharedImage {
  base64: string
  media_type: string
  name: string
}

interface SharePayload {
  title: string | null
  text: string | null
  url: string | null
  images: SharedImage[]
  received_at: string
}

/**
 * Reads (and clears) the payload the share-target service worker stashed
 * in Cache Storage (see public/sw.js) for the Android/Chrome installed-PWA
 * POST share_target flow. Falls back to the page's own query string for
 * the GET share_target variant some platforms may use instead (?title=
 * &text=&url= — no files; iOS Safari has no share_target support at all
 * regardless of method, so this whole page is reached there only via the
 * app's own "paste a link" entry points, never an OS share sheet).
 */
async function readSharedPayload(): Promise<SharePayload | null> {
  if ('caches' in window) {
    try {
      const cache = await caches.open(SHARE_CACHE)
      const match = await cache.match(SHARE_PAYLOAD_URL)
      if (match) {
        const payload = (await match.json()) as SharePayload
        await cache.delete(SHARE_PAYLOAD_URL)
        return payload
      }
    } catch {
      // Cache Storage unavailable (private browsing, unsupported) — fall through to query-string.
    }
  }

  const params = new URLSearchParams(window.location.search)
  const title = params.get('title')
  const text = params.get('text')
  const url = params.get('url')
  if (!title && !text && !url) return null
  return { title, text, url, images: [], received_at: new Date().toISOString() }
}

type ShareStage = 'loading' | 'empty' | 'pick_trip' | 'ingesting' | 'done' | 'error'

/**
 * /share route (UX_REDESIGN.md Part 3 "Ambient AI" #1, "Share target"):
 * lands here after the OS share sheet (Android: share directly from
 * Gmail/Booking/Airbnb/Photos into the installed PWA) hands off through
 * the service worker, or via the GET fallback / this page linked directly.
 * Picks a trip (if the user has more than one active one), calls the
 * existing `ingest` edge function with whatever was shared, and lets the
 * resulting ai_proposals row surface as review cards on that trip's chat
 * (ChatSheet already renders any pending proposal for the trip as an
 * "orphan proposal" — see ChatSheet.tsx — so this page doesn't need its
 * own review-card UI, just a confirmation + a link into the trip).
 *
 * Platform reality, stated plainly (workstream judgment call, reported per
 * the brief): GitHub Pages is 100% static, so a POST share_target (the
 * only method that can carry shared files) needs SOMETHING running
 * client-side to receive the request — there is no server. This ships a
 * minimal, hand-rolled service worker (public/sw.js, ~90 lines, no
 * workbox) whose only job is catching that one POST and stashing the
 * payload in Cache Storage before redirecting here. Android/Chrome:
 * installed PWA gets a real "Share to Trips" target with title/text/url
 * AND images. iOS Safari: Apple has never implemented share_target at
 * all (any method) — there is no way to appear in iOS's native share
 * sheet from a web app, service worker or not. iOS users keep using the
 * existing paste/photo entry points (PasteALinkSheet, quick-capture)
 * instead; this page still works for them if reached directly (e.g. a
 * bookmark), it just never appears as an OS share target.
 */
export function SharePage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { showToast } = useToast()
  const { data: trips, isLoading: tripsLoading } = useTrips()

  const [payload, setPayload] = useState<SharePayload | null>(null)
  const [stage, setStage] = useState<ShareStage>('loading')
  const [error, setError] = useState<string | null>(null)
  const [resultTripId, setResultTripId] = useState<string | null>(null)
  const [autoApplied, setAutoApplied] = useState(false)

  useEffect(() => {
    let cancelled = false
    readSharedPayload().then((p) => {
      if (cancelled) return
      if (!p) {
        setStage('empty')
        return
      }
      setPayload(p)
      setStage('pick_trip')
    })
    return () => {
      cancelled = true
    }
  }, [])

  const activeTrips = useMemo(() => {
    if (!trips) return []
    const today = new Date().toISOString().slice(0, 10)
    return trips.filter((t) => t.end_date >= today)
  }, [trips])

  // Exactly one active trip -> skip the picker entirely (spec: "trip
  // picker if >1 active trip").
  useEffect(() => {
    if (stage === 'pick_trip' && activeTrips.length === 1 && payload) {
      void runIngest(activeTrips[0].id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, activeTrips.length, payload])

  const runIngest = async (tripId: string) => {
    if (!payload || !user) return
    setStage('ingesting')
    setError(null)
    setAutoApplied(false)
    try {
      const firstImage = payload.images[0]
      const body: Record<string, unknown> = { trip_id: tripId }
      if (firstImage) {
        body.image_base64 = firstImage.base64
        body.image_media_type = firstImage.media_type
      } else if (payload.url) {
        body.url = payload.url
      } else {
        // Share sheets commonly put the link in `text` (e.g. Chrome's
        // "Share..." on a page shares url in both `url` AND `text`; some
        // apps only populate `text`). Prefer whichever actually looks
        // like a URL so plain-text shares still work as free text.
        const combined = [payload.title, payload.text].filter(Boolean).join('\n')
        const urlMatch = combined.match(/https?:\/\/\S+/)
        if (urlMatch) body.url = urlMatch[0]
        else body.text = combined || payload.text || payload.title
      }

      const { data, error: invokeError } = await supabase.functions.invoke('ingest', { body })
      if (invokeError) throw invokeError
      if (!data?.success) throw new Error(data?.error || 'Could not process what you shared')

      const result = data.result as IngestResult
      if (result.classification === 'option') {
        // Options need a section_id the ingest call can't supply — same
        // limitation PasteALinkSheet documents. Send the organizer into
        // the trip's Plan tab to finish adding it manually; still far
        // faster than re-typing everything from the shared link.
        showToast({
          type: 'info',
          message: 'Looks like an option to compare',
          description: 'Open the trip and use "Paste a link" in Plan to finish adding it.',
        })
        setResultTripId(tripId)
        setStage('done')
        return
      }

      // AI autonomy dial (UX_REDESIGN.md Part 3 "Ambient AI" #2): this
      // share IS the current user's own upload by construction (they're
      // the one sharing it right now), so if the trip has opted into
      // auto_own_uploads and the parse is clean/high-confidence, apply
      // immediately instead of waiting on the chat's review card.
      const trip = (trips ?? []).find((t) => t.id === tripId)
      const aiAutonomy = trip ? parseAiAutonomy(trip.chase_settings) : 'suggest'
      const proposalId: string | null = data.proposal_id ?? null
      const rawActions = data.proposal?.actions ?? null

      const eligible =
        proposalId &&
        rawActions &&
        isEligibleForAutoApply(
          {
            aiAutonomy,
            isOwnUpload: true,
            classification: result.classification,
            reconciliation: data.reconciliation ?? null,
          },
          rawActions
        )

      if (eligible && trip) {
        await autoApplyProposal(proposalId, rawActions, trip, user.id, showToast)
        setAutoApplied(true)
      } else {
        showToast({ type: 'success', message: 'Added to the trip for review', description: 'Check the trip chat to approve it.' })
      }

      setResultTripId(tripId)
      setStage('done')
    } catch (err) {
      setError((err as Error).message)
      setStage('error')
    }
  }

  if (!user) {
    // ProtectedRoute normally handles this, but a share-sheet cold-start
    // can land here before auth resolves — a short skeleton is better than
    // a flash of nothing.
    return (
      <div className="max-w-md mx-auto p-4">
        <Skeleton variant="card" height={160} />
      </div>
    )
  }

  return (
    <div className="max-w-md mx-auto p-4 space-y-4">
      <h1 className="text-xl font-semibold text-[var(--text-primary)]">Add to a trip</h1>

      {(stage === 'loading' || tripsLoading) && <Skeleton variant="card" height={160} />}

      {stage === 'empty' && (
        <EmptyState
          icon="📤"
          title="Nothing was shared"
          description="Share a link, photo, or text into Trips from another app, or use Paste a link/Scan a receipt inside a trip instead."
          action={
            <Button variant="secondary" onClick={() => navigate('/')}>
              Back to your trips
            </Button>
          }
        />
      )}

      {stage === 'pick_trip' && payload && (
        <Card>
          <Card.Content className="space-y-3">
            <SharePreview payload={payload} />
            {activeTrips.length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)]">You don't have any active trips to add this to.</p>
            ) : (
              <>
                <p className="text-sm text-[var(--text-secondary)]">Which trip is this for?</p>
                <div className="space-y-2">
                  {activeTrips.map((trip) => (
                    <button
                      key={trip.id}
                      type="button"
                      onClick={() => runIngest(trip.id)}
                      className="w-full text-left rounded-[var(--radius-md)] border border-[var(--border-default)] px-3 py-2.5 hover:border-accent-400 transition-colors"
                    >
                      <span className="font-medium text-[var(--text-primary)]">{trip.name}</span>
                      <span className="block text-xs text-[var(--text-muted)]">{trip.location}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </Card.Content>
        </Card>
      )}

      {stage === 'ingesting' && (
        <Card>
          <Card.Content>
            <Skeleton variant="list" lines={3} />
            <p className="mt-2 text-sm text-[var(--text-muted)]">Reading what you shared…</p>
          </Card.Content>
        </Card>
      )}

      {stage === 'done' && resultTripId && (
        <Card>
          <Card.Content className="space-y-3 text-center py-6">
            <p className="text-3xl" aria-hidden="true">
              {autoApplied ? '⚡' : '✅'}
            </p>
            <p className="text-sm text-[var(--text-secondary)]">
              {autoApplied
                ? 'Added to the plan automatically (auto) — logged in the activity feed. You can always delete it from the trip if that was a mistake.'
                : 'Staged for review — nothing is added until you approve it.'}
            </p>
            <Button onClick={() => navigate(`/${resultTripId}`)}>Open the trip</Button>
          </Card.Content>
        </Card>
      )}

      {stage === 'error' && (
        <Card>
          <Card.Content className="space-y-3">
            <p className="text-sm text-danger-600">{error}</p>
            <Button variant="secondary" onClick={() => navigate('/')}>
              Back to your trips
            </Button>
          </Card.Content>
        </Card>
      )}
    </div>
  )
}

/**
 * Applies the single action of a fresh, auto-apply-eligible proposal
 * immediately under the current user's JWT (same `applyAction` code path
 * manual review uses — see applyProposal.ts), marks the proposal
 * 'approved' + activity-logged as "(auto-applied)", and shows a toast with
 * an inline Undo (deletes exactly the row that was just created). Deletes/
 * updates are never reachable here — isEligibleForAutoApply already
 * excludes them structurally.
 */
async function autoApplyProposal(
  proposalId: string,
  rawActions: Json,
  trip: Trip,
  userId: string,
  showToast: (options: ToastOptions) => void
): Promise<void> {
  const entries = parseProposalActions(rawActions)
  const entry = entries[0]
  if (!entry?.action) return

  const createdRef = await applyAction(entry.action, { tripId: trip.id, userId, baseCurrency: trip.base_currency || 'GBP' })
  saveAppliedKey(proposalId, entry.key)

  await supabase.from('ai_proposals').update({ status: 'approved', reviewed_by: userId, applied_at: new Date().toISOString() }).eq('id', proposalId)

  await supabase.from('activity_feed').insert({
    trip_id: trip.id,
    actor: userId,
    verb: 'proposal_auto_applied',
    entity: { type: 'ai_proposal', id: proposalId, label: describeAction(entry.action).summary } as unknown as Json,
    metadata: { auto_applied: true } as unknown as Json,
  })

  const desc = describeAction(entry.action)
  showToast({
    type: 'success',
    message: `${desc.title} — added to plan (auto)`,
    description: desc.summary,
    duration: 10000,
    action: createdRef
      ? {
          label: 'Undo',
          onClick: () => {
            void undoCreatedEntity(createdRef)
            showToast({ type: 'info', message: 'Undone', description: `"${desc.summary}" was removed.` })
          },
        }
      : undefined,
  })
}

function SharePreview({ payload }: { payload: SharePayload }) {
  return (
    <div className="rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3 space-y-1">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Shared with you</p>
      {payload.title && <p className="text-sm font-medium text-[var(--text-primary)]">{payload.title}</p>}
      {payload.text && <p className="text-sm text-[var(--text-secondary)] break-words">{payload.text}</p>}
      {payload.url && <p className="text-sm text-accent-700 break-all">{payload.url}</p>}
      {payload.images.length > 0 && (
        <p className="text-xs text-[var(--text-muted)]">📷 {payload.images.length} image{payload.images.length === 1 ? '' : 's'} shared</p>
      )}
    </div>
  )
}
