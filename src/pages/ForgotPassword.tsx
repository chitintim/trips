import { useState, FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { Button, Input, Card } from '../components/ui'

export function ForgotPassword() {
  const { resetPassword } = useAuth()
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const { error } = await resetPassword(email)

      if (error) {
        setError(error.message)
      } else {
        setSuccess(true)
      }
    } catch (err) {
      setError('An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-sky-50 to-orange-50 flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <Card.Content className="text-center py-8">
            <div className="text-6xl mb-4">📧</div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">
              Check Your Email
            </h2>
            <p className="text-gray-600 mb-4">
              We've sent a password reset link to <strong>{email}</strong>
            </p>
            <p className="text-sm text-gray-500 mb-6">
              Click the link in the email to reset your password. The link will expire in 1 hour.
            </p>
            <Link to="/login">
              <Button variant="outline" fullWidth>
                Back to Login
              </Button>
            </Link>
          </Card.Content>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-sky-50 to-orange-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo/Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">
            🎿 Tim's Super Trip Planner
          </h1>
          <p className="text-gray-600">
            Reset your password
          </p>
        </div>

        {/* Forgot Password Card */}
        <Card>
          <Card.Header>
            <Card.Title>Forgot Password?</Card.Title>
            <Card.Description>
              Enter your email and we'll send you a link to reset your password
            </Card.Description>
          </Card.Header>

          <Card.Content>
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Error Message */}
              {error && (
                <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-sm">
                  {error}
                </div>
              )}

              {/* Email Input */}
              <Input
                label="Email"
                type="email"
                value={email}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
                placeholder="tim@example.com"
                required
                disabled={loading}
              />

              {/* Submit Button */}
              <Button
                type="submit"
                variant="primary"
                fullWidth
                isLoading={loading}
              >
                Send Reset Link
              </Button>
            </form>
          </Card.Content>

          <Card.Footer>
            <p className="text-center text-sm text-gray-600">
              Remember your password?{' '}
              <Link
                to="/login"
                className="text-sky-600 hover:text-sky-700 font-medium hover:underline"
              >
                Sign in
              </Link>
            </p>
          </Card.Footer>
        </Card>
      </div>
    </div>
  )
}
