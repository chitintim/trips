import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { reportError } from '../lib/reportError'
import { reconcilePendingSignup } from '../features/auth/lib/finalizeSignup'
import { Button, Spinner } from './ui'

type Status = 'idle' | 'processing' | 'error'

/**
 * Component that detects auth callbacks from email links and redirects appropriately
 * Supabase sends users back to the site URL with hash parameters like:
 * #access_token=...&type=recovery (for password reset)
 * #access_token=...&type=signup (for email confirmation)
 *
 * Mounted once at the app root (sibling of <Routes>, not a route of its
 * own — see App.tsx), so it renders on every page. It must stay invisible
 * (return null) for the overwhelmingly common case of a normal navigation
 * with no auth hash; the spinner/error states below only ever show while
 * there's a hash to process.
 */
export function AuthCallback() {
  const navigate = useNavigate()
  const location = useLocation()
  const [status, setStatus] = useState<Status>('idle')

  useEffect(() => {
    if (!location.hash) {
      setStatus('idle')
      return
    }

    const hashParams = new URLSearchParams(location.hash.substring(1))
    const type = hashParams.get('type')
    const accessToken = hashParams.get('access_token')

    if (type === 'recovery') {
      // Password recovery - redirect to reset password page (only if not already there)
      if (location.pathname !== '/reset-password') {
        setStatus('processing')
        // Preserve the hash when redirecting
        navigate('/reset-password' + location.hash, { replace: true })
      } else {
        // Already there (this is the re-render after the navigate above) --
        // hand off to ResetPassword's own session-detection UI instead of
        // sitting in 'processing' forever, which would otherwise permanently
        // overlay that page with this component's spinner.
        setStatus('idle')
      }
      return
    }

    if (type === 'signup' && accessToken) {
      setStatus('processing')
      // Email confirmation. A user who clicked the emailed magic link
      // (instead of typing the 6-digit code into Signup's verify step)
      // lands here signed in but WITHOUT Signup.tsx's finalizeAccount
      // having run -- profile fields and invitation consumption would be
      // silently dropped. Reconcile from the pending payload Signup stored
      // in localStorage when it requested the OTP (no-op when absent or
      // already finalized) before heading to the dashboard. Reconciliation
      // failures are reported but never trap the user on this spinner --
      // the trigger-populated metadata profile still exists either way.
      let cancelled = false
      // detectSessionInUrl may still be exchanging the hash for a session
      // when this effect runs, so fall back to waiting (bounded) for the
      // SIGNED_IN event before giving up on reconciliation.
      const waitForUserId = async (): Promise<string | null> => {
        const { data: { session } } = await supabase.auth.getSession()
        if (session?.user) return session.user.id
        return new Promise((resolve) => {
          // Timer created first (it can never fire before the next macrotask,
          // so `subscription` below is always initialized when it runs).
          const timer = setTimeout(() => {
            subscription.unsubscribe()
            resolve(null)
          }, 5000)
          const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
            if (s?.user) {
              clearTimeout(timer)
              subscription.unsubscribe()
              resolve(s.user.id)
            }
          })
        })
      }
      void (async () => {
        try {
          const userId = await waitForUserId()
          if (userId) await reconcilePendingSignup(userId)
        } catch (err) {
          reportError(err, 'auth-callback:reconcile-pending-signup')
        }
        if (!cancelled) navigate('/', { replace: true })
      })()
      return () => {
        cancelled = true
      }
    }

    // Hash present but not a recovery/signup callback. Only treat it as a
    // (broken) auth callback if it actually looks like one -- other parts of
    // the app may legitimately use hash fragments for their own purposes
    // (e.g. deep-linking to `#day-3` within a trip, see
    // postLoginRedirect.test.ts), and those must keep rendering normally
    // rather than being swallowed by this component.
    const looksLikeAuthHash =
      hashParams.has('access_token') || hashParams.has('error') || hashParams.has('error_description') || !!type
    if (!looksLikeAuthHash) {
      setStatus('idle')
      return
    }

    // Supabase's client (detectSessionInUrl) may still be establishing a
    // session from this hash asynchronously, so check before declaring the
    // link broken.
    let cancelled = false
    setStatus('processing')
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) return
      setStatus(session ? 'idle' : 'error')
    })
    return () => {
      cancelled = true
    }
  }, [location.hash, location.pathname, navigate])

  if (status === 'idle') return null

  if (status === 'error') {
    return (
      <div className="fixed inset-0 z-modal bg-[var(--surface-page)] flex items-center justify-center p-4">
        <div className="text-center max-w-xs space-y-3">
          <p className="text-3xl">⚠️</p>
          <p className="text-[var(--text-primary)] font-medium">This link isn't working</p>
          <p className="text-sm text-[var(--text-secondary)]">
            It may have expired or already been used. Try signing in again.
          </p>
          <Button variant="primary" onClick={() => navigate('/login', { replace: true })}>
            Go to login
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-modal bg-[var(--surface-page)] flex items-center justify-center">
      <div className="text-center">
        <Spinner size="lg" />
        <p className="text-sm text-[var(--text-secondary)] mt-4">Signing you in…</p>
      </div>
    </div>
  )
}
