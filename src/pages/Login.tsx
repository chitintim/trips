import { useState, FormEvent } from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { Button, Input, Card } from '../components/ui'

export function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const { error } = await signIn({ email, password })

      if (error) {
        setError(error.message)
      } else {
        // Redirect to intended destination or dashboard
        const from = (location.state as any)?.from?.pathname || '/'
        navigate(from, { replace: true })
      }
    } catch (err) {
      setError('An unexpected error occurred')
    } finally {
      setLoading(false)
    }
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
            Welcome back! Sign in to continue.
          </p>
        </div>

        {/* Login Card */}
        <Card>
          <Card.Header>
            <Card.Title>Sign In</Card.Title>
            <Card.Description>
              Enter your email and password to access your account
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

              {/* Password Input */}
              <Input
                label="Password"
                type="password"
                value={password}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                disabled={loading}
              />

              {/* Forgot Password Link */}
              <div className="text-right">
                <Link
                  to="/forgot-password"
                  className="text-sm text-sky-600 hover:text-sky-700 hover:underline"
                >
                  Forgot password?
                </Link>
              </div>

              {/* Submit Button */}
              <Button
                type="submit"
                variant="primary"
                fullWidth
                isLoading={loading}
              >
                Sign In
              </Button>
            </form>
          </Card.Content>

          <Card.Footer>
            <p className="text-center text-sm text-gray-600">
              Don't have an account?{' '}
              <Link
                to="/signup"
                className="text-sky-600 hover:text-sky-700 font-medium hover:underline"
              >
                Sign up with invitation code
              </Link>
            </p>
          </Card.Footer>
        </Card>

        {/* Footer Note */}
        <p className="text-center text-xs text-gray-500 mt-6">
          This app is invitation-only. Contact Tim for an access code.
        </p>
      </div>
    </div>
  )
}
