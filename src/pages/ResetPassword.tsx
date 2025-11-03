import { useState, useEffect, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Button, Input, Card } from '../components/ui'

export function ResetPassword() {
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)
  const [validatingLink, setValidatingLink] = useState(true)

  useEffect(() => {
    let isSubscribed = true

    // Supabase automatically handles the hash tokens from password reset emails
    // Listen for the auth state change to know when the session is ready
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession()

      if (!isSubscribed) return

      if (session) {
        // Valid session found
        setValidatingLink(false)
      } else {
        // No session yet - wait for auth state change
        // If no session appears within 3 seconds, show error
        setTimeout(() => {
          if (isSubscribed && !session) {
            setError('Invalid or expired reset link. Please request a new one.')
            setValidatingLink(false)
          }
        }, 3000)
      }
    }

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!isSubscribed) return

      if (event === 'PASSWORD_RECOVERY' && session) {
        // Password recovery session established successfully
        setValidatingLink(false)
        setError(null)
      } else if (event === 'SIGNED_OUT' || (!session && event !== 'INITIAL_SESSION')) {
        setError('Invalid or expired reset link. Please request a new one.')
        setValidatingLink(false)
      }
    })

    checkSession()

    return () => {
      isSubscribed = false
      subscription.unsubscribe()
    }
  }, [])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)

    // Validate passwords match
    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    // Validate password length
    if (password.length < 6) {
      setError('Password must be at least 6 characters')
      return
    }

    setLoading(true)

    try {
      const { error } = await supabase.auth.updateUser({
        password: password
      })

      if (error) {
        setError(error.message)
      } else {
        setSuccess(true)
        // Redirect to dashboard after 2 seconds
        setTimeout(() => {
          navigate('/')
        }, 2000)
      }
    } catch (err) {
      setError('An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }

  // Show loading state while validating the reset link
  if (validatingLink) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-sky-50 to-orange-50 flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <Card.Content className="text-center py-8">
            <div className="text-6xl mb-4">🔄</div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">
              Validating Reset Link...
            </h2>
            <p className="text-gray-600">
              Please wait while we verify your password reset link.
            </p>
          </Card.Content>
        </Card>
      </div>
    )
  }

  if (success) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-sky-50 to-orange-50 flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <Card.Content className="text-center py-8">
            <div className="text-6xl mb-4">✅</div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">
              Password Updated!
            </h2>
            <p className="text-gray-600">
              Your password has been successfully changed. Redirecting to dashboard...
            </p>
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
            Set your new password
          </p>
        </div>

        {/* Reset Password Card */}
        <Card>
          <Card.Header>
            <Card.Title>Reset Password</Card.Title>
            <Card.Description>
              Choose a new password for your account
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

              {/* New Password Input */}
              <Input
                label="New Password"
                type="password"
                value={password}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                disabled={loading}
                helperText="Minimum 6 characters"
              />

              {/* Confirm Password Input */}
              <Input
                label="Confirm Password"
                type="password"
                value={confirmPassword}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
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
                Update Password
              </Button>
            </form>
          </Card.Content>
        </Card>
      </div>
    </div>
  )
}
