import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { callRpc } from '../../lib/callRpc'
import { useAuth } from '../../hooks/useAuth'
import { useCurrentUserRow } from '../../lib/queries'
import { Button, Card, Skeleton } from '../../components/ui'
import { JoinCover } from '../../components/ui/illustrations'
import { getTripAccentStyle } from '../../components/layout/tripAccent'
import { formatMoney } from '../decisions/lib/costImpact'

interface InvitationPreview {
  trip_name: string
  location: string
  start_date: string
  end_date: string
  accent_seed: string
  estimated_cost: number | null
  cost_currency: string | null
  confirmed_count: number
  organizer_first_name: string | null
}

interface ValidateInvitationResult {
  invitation_id: string
  is_valid: boolean
  reason: string
  trip_id: string | null
}

/**
 * `get_invitation_preview` is a post-codegen RPC (see
 * supabase/migrations/20260707130000_invitation_preview.sql) — the generated
 * Database types don't know it yet, hence the narrow local typing here.
 * Returns zero rows for invalid/used/expired codes. Routed through callRpc
 * (src/lib/callRpc.ts), which guarantees this never throws (a thrown
 * client-side exception used to be swallowed by useQuery into an
 * indistinguishable "invalid" dead end with zero trace, which is exactly
 * what made the 2026-07-10 incident hard to diagnose — callRpc now reports
 * every failure via reportError instead) and always calls
 * `supabase.rpc(...)` as a direct method call, so the detached-`this`
 * footgun that bit this exact call site on 2026-07-10 is structurally
 * avoided rather than relying on a comment.
 */
async function fetchInvitationPreview(code: string): Promise<InvitationPreview | null> {
  const { data, error } = await callRpc<InvitationPreview[]>('get_invitation_preview', { p_code: code })
  if (error) return null // treat any failure as "not a valid invitation"
  const rows = Array.isArray(data) ? data : []
  return rows[0] ?? null
}

function formatDateRange(startDate: string, endDate: string): string {
  const start = new Date(startDate + 'T00:00:00')
  const end = new Date(endDate + 'T00:00:00')
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' }
  return `${start.toLocaleDateString('en-GB', opts)} – ${end.toLocaleDateString('en-GB', { ...opts, year: 'numeric' })}`
}

/**
 * PUBLIC trip teaser for invitation links (UX_REDESIGN Part 2 "Invite →
 * join funnel"): /join/:code shows what you're being invited to BEFORE
 * signup — cover with the trip's accent, dates, cost band, who's-in count
 * and the organizer's name — then hands off to /signup with the code
 * pre-filled. Invalid/used/expired codes get a friendly dead-end, never a
 * crash.
 *
 * Returning users (already authenticated, e.g. they signed in via the
 * "Sign in first" link below and were carried back here by
 * postLoginRedirect) skip signup entirely and get a one-tap join instead --
 * see `handleJoinAsAuthenticated`.
 */
export function JoinTrip() {
  const { code = '' } = useParams<{ code: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { data: profile } = useCurrentUserRow(user?.id)
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)

  const { data: preview, isLoading } = useQuery({
    queryKey: ['invitationPreview', code.toUpperCase()],
    queryFn: () => fetchInvitationPreview(code),
    enabled: code.length > 0,
    retry: false,
    staleTime: 60_000,
  })

  /**
   * Same two RPCs Signup's finalizeAccount uses (validate → mark used →
   * assign to trip), reused here for an already-authenticated user instead
   * of a brand-new signup. Re-validates right before joining (rather than
   * trusting the preview fetched on page load) since the code could have
   * expired or been used by someone else in the meantime. All three calls
   * go through callRpc per src/lib/callRpc.ts's comment -- never a
   * hand-rolled supabase.rpc cast.
   */
  const handleJoinAsAuthenticated = async () => {
    if (!user) return
    setJoining(true)
    setJoinError(null)
    try {
      const { data, error } = await callRpc<ValidateInvitationResult[]>('validate_invitation_code', {
        p_code: code.toUpperCase(),
      })
      const result = Array.isArray(data) ? data[0] : data
      if (error || !result?.is_valid || !result.invitation_id) {
        setJoinError('This invitation is no longer valid. Ask your organizer for a fresh link.')
        return
      }

      const { data: marked, error: markError } = await callRpc<boolean>('mark_invitation_used', {
        p_invitation_id: result.invitation_id,
        p_user_id: user.id,
      })
      if (markError || !marked) {
        setJoinError('Something went wrong joining this trip. Please try again.')
        return
      }

      if (result.trip_id) {
        const { error: assignError } = await callRpc('assign_user_to_trip', {
          p_invitation_id: result.invitation_id,
          p_user_id: user.id,
        })
        if (assignError) {
          setJoinError('Something went wrong joining this trip. Please try again.')
          return
        }
      }

      navigate(result.trip_id ? `/${result.trip_id}` : '/', { replace: true })
    } catch {
      setJoinError('An unexpected error occurred')
    } finally {
      setJoining(false)
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[var(--surface-page)] flex items-center justify-center p-4">
        <div className="max-w-md w-full space-y-4">
          <Skeleton variant="card" height={168} />
          <Card>
            <Card.Content className="space-y-3">
              <Skeleton variant="text" lines={2} />
              <Skeleton variant="card" height={44} />
            </Card.Content>
          </Card>
        </div>
      </div>
    )
  }

  if (!preview) {
    return (
      <div className="min-h-screen bg-[var(--surface-page)] flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <Card.Content className="py-10 text-center space-y-3">
            <JoinCover className="w-32 h-24 mx-auto text-[var(--text-muted)]" />
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">This invitation link isn't valid</h1>
            <p className="text-sm text-[var(--text-secondary)]">
              The code may have expired or already been used. Ask your organizer for a fresh link.
            </p>
            <div className="flex justify-center gap-3 pt-2">
              <Link to="/login">
                <Button variant="secondary">Sign in</Button>
              </Link>
              <Link to="/signup">
                <Button variant="ghost">I have another code</Button>
              </Link>
            </div>
          </Card.Content>
        </Card>
      </div>
    )
  }

  return (
    <div
      data-trip-accent
      style={getTripAccentStyle(preview.accent_seed)}
      className="min-h-screen bg-[var(--surface-page)] flex items-center justify-center p-4"
    >
      <div className="max-w-md w-full space-y-4">
        {/* Cover */}
        <div className="bg-accent-600 text-white px-6 pt-10 pb-8 rounded-[var(--radius-xl)] text-center">
          <p className="text-white/80 text-sm font-medium uppercase tracking-wide">You're invited</p>
          <h1 className="text-3xl font-semibold mt-2">{preview.trip_name}</h1>
          <p className="text-white/90 mt-1">{preview.location}</p>
          <p className="text-white/80 text-sm mt-3">{formatDateRange(preview.start_date, preview.end_date)}</p>
        </div>

        <Card>
          <Card.Content className="space-y-3">
            {preview.organizer_first_name && (
              <p className="text-sm text-[var(--text-secondary)]">
                <span className="font-medium text-[var(--text-primary)]">{preview.organizer_first_name}</span> is
                organizing this trip.
              </p>
            )}
            <div className="flex items-center gap-4 text-sm text-[var(--text-secondary)]">
              <span>
                👥{' '}
                <span className="font-medium text-[var(--text-primary)]">
                  {preview.confirmed_count} {preview.confirmed_count === 1 ? 'person' : 'people'}
                </span>{' '}
                in so far
              </span>
              {preview.estimated_cost != null && preview.estimated_cost > 0 && (
                <span>
                  💷 ~
                  <span className="font-medium text-[var(--text-primary)]">
                    {formatMoney(preview.estimated_cost, preview.cost_currency || 'GBP')}
                  </span>
                  /person
                </span>
              )}
            </div>

            {joinError && (
              <div role="alert" className="bg-danger-50 border border-danger-200 text-danger-800 rounded-[var(--radius-md)] p-3 text-sm">
                {joinError}
              </div>
            )}

            {user ? (
              <Button fullWidth onClick={handleJoinAsAuthenticated} isLoading={joining}>
                Join this trip{profile?.first_name ? ` as ${profile.first_name}` : ''}
              </Button>
            ) : (
              <>
                <Button fullWidth onClick={() => navigate(`/signup?code=${encodeURIComponent(code.toUpperCase())}`)}>
                  Join this trip
                </Button>
                <p className="text-center text-xs text-[var(--text-muted)]">
                  Already have an account?{' '}
                  <Link
                    to="/login"
                    state={{ from: { pathname: `/join/${code.toUpperCase()}` } }}
                    className="text-accent-700 hover:underline"
                  >
                    Sign in
                  </Link>{' '}
                  to join with your existing account.
                </p>
              </>
            )}
          </Card.Content>
        </Card>
      </div>
    </div>
  )
}
