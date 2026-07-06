import { useState, FormEvent, useEffect } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { supabase } from '../../lib/supabase'
import { Button, Input, Card, SegmentedControl } from '../../components/ui'
import { AvatarBuilder } from '../../components/AvatarBuilder'
import { Welcome } from '../../components/Welcome'
import { AvatarData, Invitation } from '../../types'
import { AuthLayout } from './AuthLayout'

type Step = 'invitation' | 'details' | 'otp-verify' | 'welcome'
type AccountMode = 'otp' | 'password'

/**
 * Invitation-only signup, OTP-first: after the invitation code validates,
 * the user picks between "email me a code" (no password ever needed,
 * settable later in profile) or setting a password up front. Both paths
 * converge on the same profile completion (name + AvatarBuilder emoji)
 * before finalizing the account and consuming the invitation.
 */
export function Signup() {
  const navigate = useNavigate()
  const { signUp, requestSignupOtp, verifyEmailOtp } = useAuth()
  const [searchParams] = useSearchParams()

  const [step, setStep] = useState<Step>('invitation')

  // Invitation validation
  const [invitationCode, setInvitationCode] = useState('')
  useEffect(() => {
    const codeFromUrl = searchParams.get('code')
    if (codeFromUrl) setInvitationCode(codeFromUrl.toUpperCase())
  }, [searchParams])
  const [invitation, setInvitation] = useState<Invitation | null>(null)
  const [validatingCode, setValidatingCode] = useState(false)
  const [codeError, setCodeError] = useState<string | null>(null)

  // Account mode + profile form
  const [accountMode, setAccountMode] = useState<AccountMode>('otp')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [avatarData, setAvatarData] = useState<AvatarData>({
    emoji: '😊',
    accessory: null,
    bgColor: '#0ea5e9',
  })
  const [signupError, setSignupError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // OTP verify step
  const [otpCode, setOtpCode] = useState('')
  const [otpError, setOtpError] = useState<string | null>(null)

  const handleValidateCode = async (e: FormEvent) => {
    e.preventDefault()
    setCodeError(null)
    setValidatingCode(true)

    try {
      const codeToValidate = invitationCode.trim()

      const { data, error } = await supabase
        .from('invitations')
        .select('*')
        .eq('code', codeToValidate)
        .maybeSingle()

      const attemptSuccess = !!(data && !data.used_by && (!data.expires_at || new Date(data.expires_at) >= new Date()))
      await supabase.from('invitation_attempts').insert({
        code_attempted: codeToValidate,
        success: attemptSuccess,
        user_agent: navigator.userAgent,
      })

      if (error) {
        setCodeError('Error validating code. Please try again.')
        return
      }
      if (!data) {
        setCodeError('Invalid invitation code. Please check and try again.')
        return
      }
      if (data.used_by) {
        setCodeError('This invitation code has already been used.')
        return
      }
      if (data.expires_at && new Date(data.expires_at) < new Date()) {
        setCodeError('This invitation code has expired.')
        return
      }

      setInvitation(data)
      setStep('details')
    } catch {
      setCodeError('An unexpected error occurred')
    } finally {
      setValidatingCode(false)
    }
  }

  /** Finish account creation once we have an authenticated user (either just signed up with password, or just verified an OTP). */
  const finalizeAccount = async (userId: string) => {
    if (!invitation) return

    const { error: profileError } = await supabase
      .from('users')
      .update({
        first_name: firstName,
        last_name: lastName,
        full_name: `${firstName} ${lastName}`,
        avatar_data: avatarData as unknown as any,
      })
      .eq('id', userId)
    if (profileError) console.error('Profile update error:', profileError)

    const { data: invitationMarked, error: invitationError } = await supabase.rpc('mark_invitation_used', {
      p_invitation_id: invitation.id,
      p_user_id: userId,
    })
    if (invitationError || !invitationMarked) {
      console.error('Invitation update error:', invitationError)
    }

    if (invitation.trip_id) {
      const { error: assignError } = await supabase.rpc('assign_user_to_trip', {
        p_invitation_id: invitation.id,
        p_user_id: userId,
      })
      if (assignError) console.error('Trip assignment error:', assignError)
    }

    setStep('welcome')
  }

  // Password-mode signup: create the account and profile in one step.
  const handlePasswordSignup = async (e: FormEvent) => {
    e.preventDefault()
    setSignupError(null)
    setLoading(true)

    try {
      if (!invitation) {
        setSignupError('Invalid invitation')
        return
      }

      const { user, error: authError } = await signUp({
        email,
        password,
        options: { data: { first_name: firstName, last_name: lastName, avatar_data: avatarData as Record<string, any> } },
      })

      if (authError) {
        setSignupError(authError.message)
        return
      }
      if (!user) {
        setSignupError('Failed to create account')
        return
      }

      await finalizeAccount(user.id)
    } catch {
      setSignupError('An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }

  // OTP-mode signup: send the code first, profile details are collected
  // before sending so we can finalize immediately after verification.
  const handleSendOtp = async (e: FormEvent) => {
    e.preventDefault()
    setSignupError(null)

    if (!firstName.trim() || !lastName.trim()) {
      setSignupError('Please enter your first and last name')
      return
    }

    setLoading(true)
    try {
      const { error } = await requestSignupOtp(email)
      if (error) {
        setSignupError(error.message)
      } else {
        setStep('otp-verify')
      }
    } catch {
      setSignupError('An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }

  const handleVerifySignupOtp = async (e: FormEvent) => {
    e.preventDefault()
    setOtpError(null)
    setLoading(true)
    try {
      const { user, error } = await verifyEmailOtp(email, otpCode.trim())
      if (error) {
        setOtpError(error.message)
        return
      }
      if (!user) {
        setOtpError('Failed to verify code')
        return
      }
      await finalizeAccount(user.id)
    } catch {
      setOtpError('An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }

  if (step === 'welcome') {
    return (
      <Welcome
        firstName={firstName}
        avatarData={avatarData}
        tripId={invitation?.trip_id}
        onContinue={() => navigate('/')}
      />
    )
  }

  return (
    <AuthLayout
      title={step === 'invitation' ? 'You’re invited' : step === 'otp-verify' ? 'Check your email' : 'Create your account'}
      subtitle={
        step === 'invitation'
          ? 'Enter your invitation code to get started'
          : step === 'otp-verify'
            ? `Enter the code we sent to ${email}`
            : 'Set up your profile and avatar'
      }
    >
      {step === 'invitation' && (
        <Card>
          <Card.Content>
            <form onSubmit={handleValidateCode} className="space-y-4">
              {codeError && (
                <div className="bg-danger-50 border border-danger-200 text-danger-800 rounded-[var(--radius-md)] p-3 text-sm">
                  {codeError}
                </div>
              )}
              <Input
                label="Invitation code"
                type="text"
                value={invitationCode}
                onChange={(e) => setInvitationCode(e.target.value.toUpperCase())}
                placeholder="ABCD1234"
                required
                disabled={validatingCode}
                helperText="Enter the code exactly as provided (case-insensitive)"
                autoFocus
              />
              <Button type="submit" variant="primary" fullWidth isLoading={validatingCode}>
                Continue
              </Button>
            </form>
          </Card.Content>
          <Card.Footer>
            <p className="text-center text-sm text-[var(--text-secondary)]">
              Already have an account?{' '}
              <Link to="/login" className="text-accent-700 font-medium hover:underline">
                Sign in
              </Link>
            </p>
          </Card.Footer>
        </Card>
      )}

      {step === 'details' && (
        <Card>
          <Card.Content>
            <form onSubmit={accountMode === 'otp' ? handleSendOtp : handlePasswordSignup} className="space-y-5">
              {signupError && (
                <div className="bg-danger-50 border border-danger-200 text-danger-800 rounded-[var(--radius-md)] p-3 text-sm">
                  {signupError}
                </div>
              )}

              <SegmentedControl
                fullWidth
                value={accountMode}
                onChange={setAccountMode}
                options={[
                  { value: 'otp', label: 'Email code (no password)' },
                  { value: 'password', label: 'Set a password' },
                ]}
              />

              <Input
                label="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                disabled={loading}
              />

              {accountMode === 'password' && (
                <Input
                  label="Password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  disabled={loading}
                  helperText="Minimum 6 characters — you can also add this later in your profile"
                />
              )}

              <Input
                label="First name"
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                required
                disabled={loading}
              />
              <Input
                label="Last name"
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                required
                disabled={loading}
              />

              <div>
                <label className="block text-sm font-medium text-[var(--text-primary)] mb-3">Choose your avatar</label>
                <AvatarBuilder value={avatarData} onChange={setAvatarData} disabled={loading} />
              </div>

              <div className="flex gap-3">
                <Button type="button" variant="outline" onClick={() => setStep('invitation')} disabled={loading}>
                  Back
                </Button>
                <Button type="submit" variant="primary" fullWidth isLoading={loading}>
                  {accountMode === 'otp' ? 'Send code' : 'Create account'}
                </Button>
              </div>
            </form>
          </Card.Content>
        </Card>
      )}

      {step === 'otp-verify' && (
        <Card>
          <Card.Content>
            <form onSubmit={handleVerifySignupOtp} className="space-y-4">
              {otpError && (
                <div className="bg-danger-50 border border-danger-200 text-danger-800 rounded-[var(--radius-md)] p-3 text-sm">
                  {otpError}
                </div>
              )}
              <Input
                label="6-digit code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                placeholder="123456"
                required
                disabled={loading}
                autoFocus
              />
              <Button type="submit" variant="primary" fullWidth isLoading={loading} disabled={otpCode.length !== 6}>
                Verify & create account
              </Button>
              <button
                type="button"
                onClick={() => setStep('details')}
                className="w-full text-center text-sm text-[var(--text-secondary)] hover:underline"
                disabled={loading}
              >
                Back
              </button>
            </form>
          </Card.Content>
        </Card>
      )}

      {step === 'invitation' && (
        <p className="text-center text-xs text-[var(--text-muted)] mt-6">
          Don't have an invitation code? Contact your organizer.
        </p>
      )}
    </AuthLayout>
  )
}
