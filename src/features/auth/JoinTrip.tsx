import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { Button, Card, Spinner } from '../../components/ui'
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

/**
 * `get_invitation_preview` is a post-codegen RPC (see
 * supabase/migrations/20260707130000_invitation_preview.sql) — the generated
 * Database types don't know it yet, hence the narrow local typing here.
 * Returns zero rows for invalid/used/expired codes.
 */
async function fetchInvitationPreview(code: string): Promise<InvitationPreview | null> {
  // NOTE: must stay bound to `supabase` — supabase-js's SupabaseClient.rpc()
  // is `return this.rest.rpc(...)` internally, so extracting it as a bare
  // function reference (without .bind) makes `this` undefined at call time
  // and throws "Cannot read properties of undefined (reading 'rest')"
  // before any network request is even made. Bit us live on 2026-07-10 for
  // every /join/:code invitation link.
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>
  try {
    const { data, error } = await rpc('get_invitation_preview', { p_code: code })
    if (error) return null // treat any failure as "not a valid invitation"
    const rows = Array.isArray(data) ? (data as InvitationPreview[]) : []
    return rows[0] ?? null
  } catch (err) {
    // A thrown client-side exception (as opposed to a returned {error}) used
    // to be swallowed by useQuery into an indistinguishable "invalid" dead
    // end with zero network trace, which is exactly what made the 2026-07-10
    // incident hard to diagnose. Log it so it's at least visible in console.
    console.error('fetchInvitationPreview threw:', err)
    return null
  }
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
 */
export function JoinTrip() {
  const { code = '' } = useParams<{ code: string }>()
  const navigate = useNavigate()

  const { data: preview, isLoading } = useQuery({
    queryKey: ['invitationPreview', code.toUpperCase()],
    queryFn: () => fetchInvitationPreview(code),
    enabled: code.length > 0,
    retry: false,
    staleTime: 60_000,
  })

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[var(--surface-page)] flex items-center justify-center">
        <Spinner size="lg" label="Checking your invitation…" />
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
            <Button fullWidth onClick={() => navigate(`/signup?code=${encodeURIComponent(code.toUpperCase())}`)}>
              Join this trip
            </Button>
            <p className="text-center text-xs text-[var(--text-muted)]">
              Already have an account?{' '}
              <Link to="/login" className="text-accent-700 hover:underline">
                Sign in
              </Link>{' '}
              first, then open this link again.
            </p>
          </Card.Content>
        </Card>
      </div>
    </div>
  )
}
