import { useState, useEffect, FormEvent, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { Button, Input, Card, Spinner } from '../../components/ui'
import { AuthLayout } from './AuthLayout'

/**
 * Rebuilt from scratch (not ported) — the legacy ResetPassword had a
 * stale-closure bug in its 3s "link invalid" fallback timer (it captured
 * `session` from the render at schedule-time, so a session established
 * just after scheduling could still be reported as invalid). This version
 * uses a ref for the "have we seen a session" flag so the timeout always
 * reads live state.
 */
export function ResetPassword() {
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)
  const [validatingLink, setValidatingLink] = useState(true)
  const sessionSeenRef = useRef(false)

  useEffect(() => {
    let isSubscribed = true

    const markSessionSeen = () => {
      sessionSeenRef.current = true
      if (isSubscribed) {
        setValidatingLink(false)
        setError(null)
      }
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) markSessionSeen()
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!isSubscribed) return
      if (event === 'PASSWORD_RECOVERY' && session) {
        markSessionSeen()
      } else if (event === 'SIGNED_OUT') {
        sessionSeenRef.current = false
        setError('Invalid or expired reset link. Please request a new one.')
        setValidatingLink(false)
      }
    })

    // Fallback: if no session shows up within 3s, report the link as
    // invalid — but always read the *current* ref, never a stale closure.
    const timeout = setTimeout(() => {
      if (isSubscribed && !sessionSeenRef.current) {
        setError('Invalid or expired reset link. Please request a new one.')
        setValidatingLink(false)
      }
    }, 3000)

    return () => {
      isSubscribed = false
      clearTimeout(timeout)
      subscription.unsubscribe()
    }
  }, [])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters')
      return
    }

    setLoading(true)
    try {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) {
        setError(error.message)
      } else {
        setSuccess(true)
        setTimeout(() => navigate('/'), 2000)
      }
    } catch {
      setError('An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }

  if (validatingLink) {
    return (
      <AuthLayout title="Validating link...">
        <Card>
          <Card.Content className="text-center py-10">
            <Spinner size="lg" />
            <p className="text-sm text-[var(--text-secondary)] mt-4">
              Please wait while we verify your reset link.
            </p>
          </Card.Content>
        </Card>
      </AuthLayout>
    )
  }

  if (success) {
    return (
      <AuthLayout title="Password updated">
        <Card>
          <Card.Content className="text-center py-10">
            <div className="text-5xl mb-4">✅</div>
            <p className="text-[var(--text-secondary)]">Redirecting you to your trips...</p>
          </Card.Content>
        </Card>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title="Set a new password">
      <Card>
        <Card.Content>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="bg-danger-50 border border-danger-200 text-danger-800 rounded-[var(--radius-md)] p-3 text-sm">
                {error}
              </div>
            )}
            <Input
              label="New password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              disabled={loading}
              helperText="Minimum 6 characters"
              autoFocus
            />
            <Input
              label="Confirm password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
              required
              disabled={loading}
            />
            <Button type="submit" variant="primary" fullWidth isLoading={loading}>
              Update password
            </Button>
          </form>
        </Card.Content>
      </Card>
    </AuthLayout>
  )
}
