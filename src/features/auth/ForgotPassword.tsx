import { useState, FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { Button, Input, Card } from '../../components/ui'
import { AuthLayout } from './AuthLayout'
import { validateEmail } from './lib/validation'

export function ForgotPassword() {
  const { resetPassword } = useAuth()
  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)

    const emailErr = validateEmail(email)
    setEmailError(emailErr)
    if (emailErr) return

    setLoading(true)
    try {
      const { error } = await resetPassword(email)
      if (error) {
        setError(error.message)
      } else {
        setSuccess(true)
      }
    } catch {
      setError('An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }

  if (success) {
    return (
      <AuthLayout title="Check your email">
        <Card>
          <Card.Content className="text-center py-8">
            <div className="text-5xl mb-4">📧</div>
            <p className="text-[var(--text-secondary)] mb-1">
              We've sent a password reset link to
            </p>
            <p className="font-medium text-[var(--text-primary)] mb-4">{email}</p>
            <p className="text-sm text-[var(--text-muted)] mb-6">
              Click the link in the email to reset your password. It expires in 1 hour.
            </p>
            <Link to="/login">
              <Button variant="outline" fullWidth>
                Back to login
              </Button>
            </Link>
          </Card.Content>
        </Card>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title="Forgot password?" subtitle="We'll email you a link to reset it">
      <Card>
        <Card.Content>
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            {error && (
              <div className="bg-danger-50 border border-danger-200 text-danger-800 rounded-[var(--radius-md)] p-3 text-sm">
                {error}
              </div>
            )}
            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
                setEmailError(null)
              }}
              placeholder="you@example.com"
              required
              disabled={loading}
              autoFocus
              error={emailError ?? undefined}
            />
            <Button type="submit" variant="primary" fullWidth isLoading={loading}>
              Send reset link
            </Button>
          </form>
        </Card.Content>
        <Card.Footer>
          <p className="text-center text-sm text-[var(--text-secondary)]">
            Remember your password?{' '}
            <Link to="/login" className="text-accent-700 font-medium hover:underline">
              Sign in
            </Link>
          </p>
        </Card.Footer>
      </Card>
    </AuthLayout>
  )
}
