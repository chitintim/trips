import { useState, FormEvent, useEffect, useMemo } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { supabase } from '../../lib/supabase'
import { callRpc } from '../../lib/callRpc'
import { useFormDraft } from '../../lib/forms/useFormDraft'
import { useUnsavedChangesGuard } from '../../lib/forms/useUnsavedChangesGuard'
import { Button, Input, Card, SegmentedControl, Stepper, Avatar } from '../../components/ui'
import { AvatarBuilder } from '../../components/AvatarBuilder'
import { AvatarIconPicker } from '../../components/AvatarIconPicker'
import { AvatarPhotoPicker } from '../../components/AvatarPhotoPicker'
import { Welcome } from '../../components/Welcome'
import { processAndUploadAvatar } from '../../lib/avatarUpload'
import { type AvatarIconName } from '../../components/ui/Avatar'
import { AvatarData, AnyAvatarData } from '../../types'
import { AuthLayout } from './AuthLayout'
import { validateEmail, validatePassword, validateRequired } from './lib/validation'
import { finalizeSignup, storePendingSignup, clearPendingSignup } from './lib/finalizeSignup'
import { reportError } from '../../lib/reportError'

type Step = 'invitation' | 'details' | 'otp-verify' | 'welcome'
type AccountMode = 'otp' | 'password'
type AvatarTab = 'photo' | 'icons' | 'emoji'

// Matches ProfileModal's DEFAULT_ICON (same default icon/color for both
// pickers, since they're the same design).
const DEFAULT_ICON: { icon: AvatarIconName; bgColor: string } = { icon: 'mountain', bgColor: '#0ea5e9' }
const DEFAULT_EMOJI_AVATAR: AvatarData = { emoji: '😊', accessory: null, bgColor: '#0ea5e9' }

/**
 * `log_invitation_attempt` is a post-codegen RPC (see
 * supabase/migrations/20260710150000_log_invitation_attempt.sql) — the
 * generated Database types don't know it yet. invitation_attempts is a
 * write-only audit log; a logging failure must never block or throw into
 * the signup flow, which callRpc guarantees (it never throws — see
 * src/lib/callRpc.ts). Post-codegen RPCs go through callRpc; don't
 * hand-roll a bind+cast here.
 */
async function logInvitationAttempt(code: string, success: boolean): Promise<void> {
  await callRpc('log_invitation_attempt', {
    p_code: code,
    p_success: success,
    p_user_agent: navigator.userAgent,
  })
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

/** Fields draft-persisted across the details step (Form & Flow Standard §5.2)
 * -- an app-switch mid-signup (e.g. tabbing away to fetch an OTP from email)
 * must not lose what the user already typed. Deliberately excludes:
 *  - `password`: sessionStorage is readable by any script/extension on the
 *    page, and unlike name/avatar it's a single quick field to retype, so
 *    the security cost of persisting it isn't worth the convenience.
 *  - the pending photo File: not JSON-serializable (see below, kept in
 *    plain state and accepted lost on reload).
 */
interface SignupDraftValues {
  email: string
  firstName: string
  lastName: string
  avatarTab: AvatarTab
  iconChoice: { icon: AvatarIconName; bgColor: string }
  avatarData: AvatarData
}

const EMPTY_DRAFT: SignupDraftValues = {
  email: '',
  firstName: '',
  lastName: '',
  avatarTab: 'icons',
  iconChoice: DEFAULT_ICON,
  avatarData: DEFAULT_EMOJI_AVATAR,
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

  // Invitation validation. Lazy-initialized from the URL (not a useEffect)
  // so a `?code=` deep link is available synchronously on first render --
  // needed so the draft below can be keyed correctly from the very first
  // mount instead of a tick later.
  const [invitationCode, setInvitationCode] = useState(() => searchParams.get('code')?.toUpperCase() ?? '')
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

  // Field-level validation errors (Form & Flow Standard: submitting invalid
  // input must show inline, role="alert" text under the offending field --
  // never a silent no-op).
  const [emailError, setEmailError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [firstNameError, setFirstNameError] = useState<string | null>(null)
  const [lastNameError, setLastNameError] = useState<string | null>(null)

  // Avatar system v2 (UX_REDESIGN.md "Avatar system v2"): same three-tab
  // Photo/Icons/Emoji picker as ProfileModal, so the account-creation avatar
  // UI matches profile editing instead of only offering the legacy emoji
  // builder. Defaults to "icons" (the new primary), not "emoji" (legacy) --
  // there's no existing avatar to preserve at signup, unlike ProfileModal's
  // `initialTabFor(user)`.
  const [avatarTab, setAvatarTab] = useState<AvatarTab>('icons')
  // Collapsed by default (Form & Flow Standard, "compact by default"): the
  // picker takes ~2/3 of the details screen otherwise, and most users are
  // happy with the default icon. Tapping the summary row expands the full
  // tab control + picker body.
  const [avatarExpanded, setAvatarExpanded] = useState(false)
  const [pendingPhotoFile, setPendingPhotoFile] = useState<File | null>(null)
  const [iconChoice, setIconChoice] = useState<{ icon: AvatarIconName; bgColor: string }>(DEFAULT_ICON)
  const [avatarData, setAvatarData] = useState<AvatarData>(DEFAULT_EMOJI_AVATAR)
  // What actually got saved once finalizeAccount runs -- passed to Welcome
  // so its hero avatar matches whichever tab (photo/icon/emoji) was used,
  // instead of Welcome only ever knowing how to render the emoji shape.
  const [savedAvatarUrl, setSavedAvatarUrl] = useState<string | null>(null)
  const [savedAvatarData, setSavedAvatarData] = useState<AnyAvatarData | null>(null)

  const [signupError, setSignupError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Set when the auth user exists but finalizeAccount failed (profile
  // update / invitation consumption) -- drives the "Try again" button so
  // the user is never silently advanced past a half-created account.
  const [finalizeRetryUserId, setFinalizeRetryUserId] = useState<string | null>(null)

  // OTP verify step
  const [otpCode, setOtpCode] = useState('')
  const [otpError, setOtpError] = useState<string | null>(null)

  // Draft persistence for the details step (P5): keyed per invitation code
  // so different invite links never collide. Restoration only works when
  // the code arrived via URL (see lazy init above) -- a manually-typed code
  // means the key isn't known until the user has already typed it, so
  // there's nothing to restore on that particular mount; a low-risk
  // tradeoff since real invites are almost always clicked links, not
  // hand-typed codes.
  const draftKey = `signup-details:${invitationCode || 'no-code'}`
  const { values: draft, setValues: setDraft, clearDraft: clearSignupDraft, isRestored } = useFormDraft<SignupDraftValues>(
    draftKey,
    EMPTY_DRAFT,
    { enabled: invitationCode.length > 0 }
  )

  // One-time hydration from the restored draft into the individual field
  // states that the rest of this component (and its many handlers) reads
  // directly -- keeps the existing field-by-field structure intact instead
  // of a risky full refactor to a single values object.
  useEffect(() => {
    if (!isRestored) return
    setEmail(draft.email)
    setFirstName(draft.firstName)
    setLastName(draft.lastName)
    setAvatarTab(draft.avatarTab)
    setIconChoice(draft.iconChoice)
    setAvatarData(draft.avatarData)
    // Only ever hydrate once, right after restoration is detected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRestored])

  // Signup is a full page, not a closable modal -- only the beforeunload
  // half of this hook is relevant here (no confirm-discard sheet to render).
  const isDirty =
    (step === 'details' || step === 'otp-verify') &&
    Boolean(email.trim() || firstName.trim() || lastName.trim() || password)
  useUnsavedChangesGuard(isDirty)

  // Local preview for the pending photo file (not draft-persisted -- File
  // objects aren't JSON-serializable) so the compact avatar summary row can
  // show it even before upload happens in finalizeAccount.
  const photoPreviewUrl = useMemo(() => {
    if (avatarTab !== 'photo' || !pendingPhotoFile) return null
    return URL.createObjectURL(pendingPhotoFile)
  }, [avatarTab, pendingPhotoFile])
  useEffect(() => {
    return () => {
      if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl)
    }
  }, [photoPreviewUrl])

  const handleValidateCode = async (e: FormEvent) => {
    e.preventDefault()
    setCodeError(null)

    const codeToValidate = invitationCode.trim()
    const requiredErr = validateRequired(codeToValidate, 'Invitation code')
    if (requiredErr) {
      setCodeError(requiredErr)
      return
    }

    setValidatingCode(true)
    try {
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

  /**
   * Finish account creation once we have an authenticated user (either just
   * signed up with password, or just verified an OTP). Idempotent -- the
   * "Try again" retry path re-runs it wholesale (the profile update just
   * rewrites the same values; mark_invitation_used returning false on a
   * retry means we already consumed it ourselves, treated as non-fatal by
   * finalizeSignup).
   */
  const finalizeAccount = async (userId: string) => {
    if (!invitation) return

    // Avatar system v2: mirrors ProfileModal.handleSubmit's branching. Photo
    // upload can only happen now (not in signUp's options.data) because it
    // needs the real userId for the storage path -- a failed upload must
    // not block account creation, so it's caught and reported rather than
    // thrown.
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
        reportError(err, 'signup:avatar-upload')
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

    const result = await finalizeSignup({
      userId,
      invitationId: invitation.id,
      tripId: invitation.trip_id,
      profileUpdate: update,
    })

    if (!result.ok) {
      // Visible error + retry instead of silently advancing to welcome
      // with a half-created account. The auth user already exists, so the
      // retry only re-runs the finalize writes.
      setFinalizeRetryUserId(userId)
      const message = `${result.errors.join(' ')} Your account was created — tap Try again to finish setting it up.`
      if (step === 'otp-verify') {
        setOtpError(message)
      } else {
        setSignupError(message)
      }
      return
    }

    setFinalizeRetryUserId(null)
    clearPendingSignup()
    clearSignupDraft()
    setStep('welcome')
  }

  const handleRetryFinalize = async () => {
    if (!finalizeRetryUserId) return
    setSignupError(null)
    setOtpError(null)
    setLoading(true)
    try {
      await finalizeAccount(finalizeRetryUserId)
    } catch {
      const message = 'An unexpected error occurred. Please try again.'
      if (step === 'otp-verify') setOtpError(message)
      else setSignupError(message)
    } finally {
      setLoading(false)
    }
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

  /** Shared client-side validation for the details step's text fields (Form &
   * Flow Standard): both submit paths need first/last name + email, and
   * password mode additionally needs a password. */
  const validateDetailsFields = (): boolean => {
    const emailErr = validateEmail(email)
    const firstNameErr = validateRequired(firstName, 'First name')
    const lastNameErr = validateRequired(lastName, 'Last name')
    const passwordErr = accountMode === 'password' ? validatePassword(password) : null
    setEmailError(emailErr)
    setFirstNameError(firstNameErr)
    setLastNameError(lastNameErr)
    setPasswordError(passwordErr)
    return !emailErr && !firstNameErr && !lastNameErr && !passwordErr
  }

  // Password-mode signup: create the account and profile in one step.
  const handlePasswordSignup = async (e: FormEvent) => {
    e.preventDefault()
    setSignupError(null)

    if (!validateDetailsFields()) return

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

    if (!validateDetailsFields()) return

    setLoading(true)
    try {
      // Same metadata as the password signUp path: the new-user trigger
      // populates public.users from raw_user_meta_data, so an OTP-created
      // account gets its name/avatar even if the client-side finalize step
      // never runs (e.g. the user clicks the emailed magic link instead of
      // typing the code -- see finalizeSignup.ts reconciliation).
      const { error } = await requestSignupOtp(email, {
        first_name: firstName,
        last_name: lastName,
        avatar_data: avatarMetadataForSignup(),
      })
      if (error) {
        setSignupError(mapSignupError(error.message))
      } else {
        if (invitation) {
          storePendingSignup({
            invitationId: invitation.id,
            tripId: invitation.trip_id,
            firstName,
            lastName,
            avatarData: (avatarMetadataForSignup() as AnyAvatarData | undefined) ?? null,
          })
        }
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
      // Re-validate the invitation before creating the account: minutes may
      // have passed since the invitation step, and another invitee could
      // have consumed the same code in the meantime. Failing here (before
      // verifyOtp) avoids creating an orphan auth user with no invitation.
      const { data: revalidateData, error: revalidateError } = await supabase.rpc('validate_invitation_code', {
        p_code: invitationCode.trim(),
      })
      const revalidated = Array.isArray(revalidateData) ? revalidateData[0] : revalidateData
      if (revalidateError || !revalidated) {
        setOtpError('Error checking your invitation. Please try again.')
        return
      }
      if (!revalidated.is_valid) {
        clearPendingSignup()
        setOtpError(
          revalidated.reason === 'already_used'
            ? 'This invitation code has already been used by someone else. Ask your organizer for a new invitation.'
            : revalidated.reason === 'expired'
              ? 'This invitation code has expired. Ask your organizer for a new invitation.'
              : 'This invitation code is no longer valid. Ask your organizer for a new invitation.'
        )
        return
      }

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
        mode={accountMode}
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

  const compactAvatarPreview =
    avatarTab === 'icons' ? { type: 'icon' as const, icon: iconChoice.icon, bgColor: iconChoice.bgColor } : avatarData

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
            <form onSubmit={handleValidateCode} className="space-y-4" noValidate>
              <Input
                label="Invitation code"
                type="text"
                value={invitationCode}
                onChange={(e) => {
                  setInvitationCode(e.target.value.toUpperCase())
                  setCodeError(null)
                }}
                placeholder="ABCD1234"
                required
                disabled={validatingCode}
                helperText="Enter the code exactly as provided (case-insensitive)"
                error={codeError ?? undefined}
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
            <form onSubmit={accountMode === 'otp' ? handleSendOtp : handlePasswordSignup} className="space-y-5" noValidate>
              {signupError && (
                <div className="bg-danger-50 border border-danger-200 text-danger-800 rounded-[var(--radius-md)] p-3 text-sm space-y-2" role="alert">
                  <p>{signupError}</p>
                  {finalizeRetryUserId && (
                    <Button type="button" variant="outline" size="sm" onClick={handleRetryFinalize} isLoading={loading}>
                      Try again
                    </Button>
                  )}
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
                onChange={(e) => {
                  setEmail(e.target.value)
                  setEmailError(null)
                  setDraft((prev) => ({ ...prev, email: e.target.value }))
                }}
                placeholder="you@example.com"
                required
                disabled={loading}
                error={emailError ?? undefined}
              />

              {accountMode === 'password' && (
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
                  helperText={passwordError ? undefined : 'Minimum 6 characters — you can also add this later in your profile'}
                  error={passwordError ?? undefined}
                />
              )}

              <Input
                label="First name"
                type="text"
                value={firstName}
                onChange={(e) => {
                  setFirstName(e.target.value)
                  setFirstNameError(null)
                  setDraft((prev) => ({ ...prev, firstName: e.target.value }))
                }}
                required
                disabled={loading}
                error={firstNameError ?? undefined}
              />
              <Input
                label="Last name"
                type="text"
                value={lastName}
                onChange={(e) => {
                  setLastName(e.target.value)
                  setLastNameError(null)
                  setDraft((prev) => ({ ...prev, lastName: e.target.value }))
                }}
                required
                disabled={loading}
                error={lastNameError ?? undefined}
              />

              <div>
                <label className="block text-sm font-medium text-[var(--text-primary)] mb-2">Avatar</label>

                {/* Compact-by-default (Form & Flow Standard): the user who
                    doesn't care gets the default icon and scrolls straight
                    past; tapping expands the full picker. */}
                <button
                  type="button"
                  onClick={() => setAvatarExpanded((v) => !v)}
                  disabled={loading}
                  aria-expanded={avatarExpanded}
                  className="w-full flex items-center gap-3 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3 text-left transition-colors hover:brightness-95"
                >
                  <Avatar
                    size="md"
                    alt="Your avatar"
                    avatarUrl={avatarTab === 'photo' ? photoPreviewUrl : undefined}
                    avatarData={avatarTab === 'photo' ? undefined : compactAvatarPreview}
                    fallback={firstName ? firstName.charAt(0) : undefined}
                  />
                  <span className="flex-1 text-sm text-[var(--text-secondary)]">
                    {avatarExpanded ? 'Choose your avatar' : "We picked a default — tap to change"}
                  </span>
                  <svg
                    className={`w-4 h-4 text-[var(--text-muted)] transition-transform shrink-0 ${avatarExpanded ? 'rotate-180' : ''}`}
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={2}
                    stroke="currentColor"
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                </button>

                {avatarExpanded && (
                  <div className="mt-3 space-y-3">
                    <SegmentedControl
                      size="sm"
                      fullWidth
                      value={avatarTab}
                      onChange={(v) => {
                        setAvatarTab(v)
                        setDraft((prev) => ({ ...prev, avatarTab: v }))
                      }}
                      options={[
                        { value: 'photo', label: 'Photo' },
                        { value: 'icons', label: 'Icons' },
                        { value: 'emoji', label: 'Emoji' },
                      ]}
                    />

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
                        onChange={(v) => {
                          setIconChoice(v)
                          setDraft((prev) => ({ ...prev, iconChoice: v }))
                        }}
                        disabled={loading}
                      />
                    )}

                    {avatarTab === 'emoji' && (
                      <AvatarBuilder
                        value={avatarData}
                        onChange={(v) => {
                          setAvatarData(v)
                          setDraft((prev) => ({ ...prev, avatarData: v }))
                        }}
                        disabled={loading}
                      />
                    )}

                    {/* Live preview of what will actually render app-wide --
                        matches ProfileModal's avatar preview pattern (Photo
                        tab already has its own crop preview above). */}
                    {avatarTab !== 'photo' && (
                      <div className="flex items-center justify-center gap-3 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3">
                        <Avatar size="lg" alt="Preview" avatarData={compactAvatarPreview} />
                        <span className="text-sm text-[var(--text-muted)]">This is how you'll appear to others</span>
                      </div>
                    )}
                  </div>
                )}
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
            <form onSubmit={handleVerifySignupOtp} className="space-y-4" noValidate>
              {otpError && (
                <div className="bg-danger-50 border border-danger-200 text-danger-800 rounded-[var(--radius-md)] p-3 text-sm space-y-2" role="alert">
                  <p>{otpError}</p>
                  {finalizeRetryUserId && (
                    <Button type="button" variant="outline" size="sm" onClick={handleRetryFinalize} isLoading={loading}>
                      Try again
                    </Button>
                  )}
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
