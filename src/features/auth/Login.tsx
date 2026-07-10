import { useState, FormEvent } from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { Button, Input, Card, SegmentedControl } from '../../components/ui'
import { AuthLayout } from './AuthLayout'
import { resolvePostLoginDestination } from './lib/postLoginRedirect'
import { validateEmail, validateRequired } from './lib/validation'

type Mode = 'password' | 'otp'
type OtpStep = 'request' | 'verify'

export function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const { signIn, requestEmailOtp, verifyEmailOtp } = useAuth()

  const [mode, setMode] = useState<Mode>('password')

  // Password tab
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // OTP tab
  const [otpStep, setOtpStep] = useState<OtpStep>('request')
  const [otpEmail, setOtpEmail] = useState('')
  const [otpCode, setOtpCode] = useState('')
  const [otpEmailError, setOtpEmailError] = useState<string | null>(null)
  const [otpError, setOtpError] = useState<string | null>(null)
  const [otpLoading, setOtpLoading] = useState(false)

  // Shared by BOTH auth paths (password submit + OTP verify): return to the
  // exact pre-auth URL — path, query AND hash (claim/join deep links).
  const goToIntendedDestination = () => {
    navigate(resolvePostLoginDestination(location.state), { replace: true })
  }

  const handlePasswordSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)

    const emailErr = validateEmail(email)
    const passwordErr = validateRequired(password, 'Password')
    setEmailError(emailErr)
    setPasswordError(passwordErr)
    if (emailErr || passwordErr) return

    setLoading(true)
    try {
      const { error } = await signIn({ email, password })
      if (error) {
        setError(error.message)
      } else {
        goToIntendedDestination()
      }
    } catch {
      setError('An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }

  const handleRequestOtp = async (e: FormEvent) => {
    e.preventDefault()
    setOtpError(null)

    const emailErr = validateEmail(otpEmail)
    setOtpEmailError(emailErr)
    if (emailErr) return

    setOtpLoading(true)
    try {
      const { error } = await requestEmailOtp(otpEmail)
      if (error) {
        setOtpError(error.message)
      } else {
        setOtpStep('verify')
      }
    } catch {
      setOtpError('An unexpected error occurred')
    } finally {
      setOtpLoading(false)
    }
  }

  const handleVerifyOtp = async (e: FormEvent) => {
    e.preventDefault()
    setOtpError(null)
    setOtpLoading(true)
    try {
      const { error } = await verifyEmailOtp(otpEmail, otpCode.trim())
      if (error) {
        setOtpError(error.message)
      } else {
        goToIntendedDestination()
      }
    } catch {
      setOtpError('An unexpected error occurred')
    } finally {
      setOtpLoading(false)
    }
  }

  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to continue planning">
      <Card>
        <Card.Content className="space-y-5">
          <SegmentedControl
            fullWidth
            value={mode}
            onChange={(v) => {
              setMode(v)
              setError(null)
              setOtpError(null)
              setEmailError(null)
              setPasswordError(null)
              setOtpEmailError(null)
            }}
            options={[
              { value: 'password', label: 'Password' },
              { value: 'otp', label: 'Email me a code' },
            ]}
          />

          {mode === 'password' && (
            <form onSubmit={handlePasswordSubmit} className="space-y-4" noValidate>
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
              <Input
                label="Password"
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value)
                  setPasswordError(null)
                }}
                placeholder="••••••••"
                required
                disabled={loading}
                error={passwordError ?? undefined}
              />
              <div className="text-right">
                <Link to="/forgot-password" className="text-sm text-accent-700 hover:underline">
                  Forgot password?
                </Link>
              </div>
              <Button type="submit" variant="primary" fullWidth isLoading={loading}>
                Sign in
              </Button>
            </form>
          )}

          {mode === 'otp' && otpStep === 'request' && (
            <form onSubmit={handleRequestOtp} className="space-y-4" noValidate>
              {otpError && (
                <div className="bg-danger-50 border border-danger-200 text-danger-800 rounded-[var(--radius-md)] p-3 text-sm">
                  {otpError}
                </div>
              )}
              <p className="text-sm text-[var(--text-secondary)]">
                We'll email you a 6-digit code — no password needed.
              </p>
              <Input
                label="Email"
                type="email"
                value={otpEmail}
                onChange={(e) => {
                  setOtpEmail(e.target.value)
                  setOtpEmailError(null)
                }}
                placeholder="you@example.com"
                required
                disabled={otpLoading}
                error={otpEmailError ?? undefined}
              />
              <Button type="submit" variant="primary" fullWidth isLoading={otpLoading}>
                Send code
              </Button>
            </form>
          )}

          {mode === 'otp' && otpStep === 'verify' && (
            <form onSubmit={handleVerifyOtp} className="space-y-4" noValidate>
              {otpError && (
                <div className="bg-danger-50 border border-danger-200 text-danger-800 rounded-[var(--radius-md)] p-3 text-sm">
                  {otpError}
                </div>
              )}
              <p className="text-sm text-[var(--text-secondary)]">
                Enter the code sent to <strong>{otpEmail}</strong>
              </p>
              <Input
                label="6-digit code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                placeholder="123456"
                required
                disabled={otpLoading}
                autoFocus
              />
              <Button type="submit" variant="primary" fullWidth isLoading={otpLoading} disabled={otpCode.length !== 6}>
                Verify & sign in
              </Button>
              <button
                type="button"
                onClick={() => {
                  setOtpStep('request')
                  setOtpCode('')
                  setOtpError(null)
                }}
                className="w-full text-center text-sm text-[var(--text-secondary)] hover:underline"
                disabled={otpLoading}
              >
                Use a different email
              </button>
            </form>
          )}
        </Card.Content>

        <Card.Footer>
          <p className="text-center text-sm text-[var(--text-secondary)]">
            Don't have an account?{' '}
            <Link to="/signup" className="text-accent-700 font-medium hover:underline">
              Sign up with invitation code
            </Link>
          </p>
        </Card.Footer>
      </Card>

      <p className="text-center text-xs text-[var(--text-muted)] mt-6">
        This app is invitation-only. Contact your organizer for an access code.
      </p>
    </AuthLayout>
  )
}
