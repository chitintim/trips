import { useState, FormEvent, useEffect } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { supabase } from '../../lib/supabase'
import { Button, Input, Card, SegmentedControl, Stepper, Avatar } from '../../components/ui'
import { AvatarBuilder } from '../../components/AvatarBuilder'
import { AvatarIconPicker } from '../../components/AvatarIconPicker'
import { AvatarPhotoPicker } from '../../components/AvatarPhotoPicker'
import { Welcome } from '../../components/Welcome'
import { processAndUploadAvatar } from '../../lib/avatarUpload'
import { type AvatarIconName } from '../../components/ui/Avatar'
import { AvatarData, AnyAvatarData } from '../../types'
import { AuthLayout } from './AuthLayout'

type Step = 'invitation' | 'details' | 'otp-verify' | 'welcome'
type AccountMode = 'otp' | 'password'
type AvatarTab = 'photo' | 'icons' | 'emoji'

// Matches ProfileModal's DEFAULT_ICON (same default icon/color for both
// pickers, since they're the same design).
const DEFAULT_ICON: { icon: AvatarIconName; bgColor: string } = { icon: 'mountain', bgColor: '#0ea5e9' }

/**
 * `log_invitation_attempt` is a post-codegen RPC (see
 * supabase/migrations/20260710150000_log_invitation_attempt.sql) — the
 * generated Database types don't know it yet, hence the local typing here
 * (mirrors fetchInvitationPreview in JoinTrip.tsx). invitation_attempts is
 * a write-only audit log; a logging failure must never block or throw into
 * the signup flow, so a failed call is only console.error'd. Must call via
 * `.bind(supabase)` — supabase-js's `rpc` reads `this.rest` internally, and
 * detaching the method from its receiver (as a plain `const rpc = supabase.rpc`)
 * throws "Cannot read properties of undefined (reading 'rest')" before any
 * request is sent, which the try/catch below exists specifically to survive.
 */
async function logInvitationAttempt(code: string, success: boolean): Promise<void> {
  try {
    const rpc = supabase.rpc.bind(supabase) as unknown as (
      fn: string,
      args: Record<string, unknown>
    ) => PromiseLike<{ data: unknown; error: { message: string } | null }>
    const { error } = await rpc('log_invitation_attempt', {
      p_code: code,
      p_success: success,
      p_user_agent: navigator.userAgent,
    })
    if (error) console.error('Failed to log invitation attempt:', error)
  } catch (err) {
    console.error('Failed to log invitation attempt:', err)
  }
}

const SIGNUP_DISABLED_PATTERN = /signups?\s*(are\s*)?not\s*allowed/i

/**
 * GoTrue returns its literal "Signups not allowed for otp"/"...for this
 * instance" string when the project's "Allow new users to sign up" Auth
 * setting is off — a Dashboard-only toggle affecting both OTP and password
 * signup identically (no per-method fallback exists), so this maps to the
 * same actionable message regardless of which form submitted it.
 */
function mapSignupError(message: string): string {
  return SIGNUP_DISABLED_PATTERN.test(message)
    ? 'Signups are currently disabled for this app — please ask your organizer to check the Supabase dashboard.'
    : message
}

/**
 * Invitation-only signup, OTP-first: after the invitation code validates,
 * the user picks between "email me a code" (no password ever needed,
 * settable later in profile) or setting a password up front. Both paths
 * converge on the same profile completion (name + avatar system v2 picker
 * -- Photo/Icons/Emoji(legacy), same as ProfileModal, UX_REDESIGN.md
 * "Avatar system v2") before finalizing the account and consuming the
 * invitation.
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
  const [invitation, setInvitation] = useState<{ id: string; trip_id: string | null } | null>(null)
  const [validatingCode, setValidatingCode] = useState(false)
  const [codeError, setCodeError] = useState<string | null>(null)

  // Account mode + profile form
  const [accountMode, setAccountMode] = useState<AccountMode>('otp')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')

  // Avatar system v2 (UX_REDESIGN.md "Avatar system v2"): same three-tab
  // Photo/Icons/Emoji picker as ProfileModal, so the account-creation avatar
  // UI matches profile editing instead of only offering the legacy emoji
  // builder. Defaults to "icons" (the new primary), not "emoji" (legacy) --
  // there's no existing avatar to preserve at signup, unlike ProfileModal's
  // `initialTabFor(user)`.
  const [avatarTab, setAvatarTab] = useState<AvatarTab>('icons')
  const [pendingPhotoFile, setPendingPhotoFile] = useState<File | null>(null)
  const [iconChoice, setIconChoice] = useState<{ icon: AvatarIconName; bgColor: string }>(DEFAULT_ICON)
  const [avatarData, setAvatarData] = useState<AvatarData>({
    emoji: '😊',
    accessory: null,
    bgColor: '#0ea5e9',
  })
  // What actually got saved once finalizeAccount runs -- passed to Welcome
  // so its hero avatar matches whichever tab (photo/icon/emoji) was used,
  // instead of Welcome only ever knowing how to render the emoji shape.
  const [savedAvatarUrl, setSavedAvatarUrl] = useState<string | null>(null)
  const [savedAvatarData, setSavedAvatarData] = useState<AnyAvatarData | null>(null)

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

      // Narrow SECURITY DEFINER RPC: invitations are not directly readable
      // pre-auth (see 20260707110000_security_hardening.sql).
      const { data, error } = await supabase.rpc('validate_invitation_code', {
        p_code: codeToValidate,
      })
      const result = Array.isArray(data) ? data[0] : data

      await logInvitationAttempt(codeToValidate, !!result?.is_valid)

      if (error || !result) {
        setCodeError('Error validating code. Please try again.')
        return
      }
      if (!result.is_valid) {
        setCodeError(
          result.reason === 'already_used'
            ? 'This invitation code has already been used.'
            : result.reason === 'expired'
              ? 'This invitation code has expired.'
              : 'Invalid invitation code. Please check and try again.'
        )
        return
      }

      setInvitation({ id: result.invitation_id!, trip_id: result.trip_id })
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

    // Avatar system v2: mirrors ProfileModal.handleSubmit's branching. Photo
    // upload can only happen now (not in signUp's options.data) because it
    // needs the real userId for the storage path -- a failed upload must
    // not block account creation, so it's caught and logged rather than
    // thrown, same as the other best-effort steps below (invitation mark,
    // trip assignment).
    const update: Record<string, unknown> = {
      first_name: firstName,
      last_name: lastName,
      full_name: `${firstName} ${lastName}`,
    }

    if (avatarTab === 'photo' && pendingPhotoFile) {
      try {
        const publicUrl = await processAndUploadAvatar(pendingPhotoFile, userId)
        update.avatar_url = publicUrl
        setSavedAvatarUrl(publicUrl)
      } catch (err) {
        console.error('Avatar upload failed:', err)
      }
    } else if (avatarTab === 'icons') {
      const iconData: AnyAvatarData = { type: 'icon', icon: iconChoice.icon, bgColor: iconChoice.bgColor }
      update.avatar_data = iconData
      update.avatar_url = null
      setSavedAvatarData(iconData)
    } else if (avatarTab === 'emoji') {
      update.avatar_data = avatarData
      update.avatar_url = null
      setSavedAvatarData(avatarData)
    }

    const { error: profileError } = await supabase
      .from('users')
      .update(update)
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

  /**
   * Initial `avatar_data` sent as auth signup metadata (raw_user_meta_data,
   * consumed by the not-migration-tracked new-user trigger that creates the
   * `public.users` row -- see `finalizeAccount`, which always overwrites it
   * right after with the authoritative value). Photo has no representation
   * here since it needs the real userId to upload to; `finalizeAccount`
   * handles it exclusively once the account exists.
   */
  const avatarMetadataForSignup = (): Record<string, unknown> | undefined => {
    if (avatarTab === 'icons') {
      return { type: 'icon', icon: iconChoice.icon, bgColor: iconChoice.bgColor }
    }
    if (avatarTab === 'emoji') {
      return avatarData as unknown as Record<string, unknown>
    }
    return undefined
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
        options: { data: { first_name: firstName, last_name: lastName, avatar_data: avatarMetadataForSignup() } },
      })

      if (authError) {
        setSignupError(mapSignupError(authError.message))
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
        setSignupError(mapSignupError(error.message))
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
        avatarUrl={savedAvatarUrl}
        avatarData={savedAvatarData}
        tripId={invitation?.trip_id}
        // Invitation tied to a trip → land INSIDE that trip (its Today
        // space shows the RSVP card), not on the dashboard (UX_REDESIGN
        // Part 2 "Invite → join funnel").
        onContinue={() => navigate(invitation?.trip_id ? `/${invitation.trip_id}` : '/')}
      />
    )
  }

  // Stepper steps (Form & Flow Standard §5.3): "otp-verify" only appears in
  // the flow when the user picked the OTP account mode, so it's omitted
  // from the rail entirely in password mode rather than shown as skipped.
  const stepperSteps =
    accountMode === 'otp'
      ? [
          { key: 'invitation', label: 'Invitation' },
          { key: 'details', label: 'Details' },
          { key: 'otp-verify', label: 'Verify' },
        ]
      : [
          { key: 'invitation', label: 'Invitation' },
          { key: 'details', label: 'Details' },
        ]

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
      <Stepper steps={stepperSteps} current={step} size="sm" className="mb-5" />
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
                <div className="flex items-center justify-between mb-3">
                  <label className="block text-sm font-medium text-[var(--text-primary)]">Choose your avatar</label>
                  <SegmentedControl
                    size="sm"
                    value={avatarTab}
                    onChange={setAvatarTab}
                    options={[
                      { value: 'photo', label: 'Photo' },
                      { value: 'icons', label: 'Icons' },
                      { value: 'emoji', label: 'Emoji' },
                    ]}
                  />
                </div>

                {avatarTab === 'photo' && (
                  <AvatarPhotoPicker
                    currentUrl={null}
                    onFileReady={setPendingPhotoFile}
                    disabled={loading}
                  />
                )}

                {avatarTab === 'icons' && (
                  <AvatarIconPicker
                    icon={iconChoice.icon}
                    bgColor={iconChoice.bgColor}
                    onChange={setIconChoice}
                    disabled={loading}
                  />
                )}

                {avatarTab === 'emoji' && (
                  <AvatarBuilder value={avatarData} onChange={setAvatarData} disabled={loading} />
                )}
              </div>

              {/* Live preview of what will actually render app-wide -- matches
                  ProfileModal's avatar preview pattern (Photo tab already has
                  its own crop preview above). */}
              {avatarTab !== 'photo' && (
                <div className="flex items-center justify-center gap-3 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3">
                  <Avatar
                    size="lg"
                    alt="Preview"
                    avatarData={avatarTab === 'icons' ? { type: 'icon', icon: iconChoice.icon, bgColor: iconChoice.bgColor } : avatarData}
                  />
                  <span className="text-sm text-[var(--text-muted)]">This is how you'll appear to others</span>
                </div>
              )}

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
