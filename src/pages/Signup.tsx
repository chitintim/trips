import { useState, FormEvent, useEffect } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'
import { Button, Input, Card } from '../components/ui'
import { AvatarBuilder } from '../components/AvatarBuilder'
import { Welcome } from '../components/Welcome'
import { AvatarData, Invitation } from '../types'

type Step = 'invitation' | 'details' | 'welcome'

export function Signup() {
  const navigate = useNavigate()
  const { signUp } = useAuth()
  const [searchParams] = useSearchParams()

  // Multi-step state
  const [step, setStep] = useState<Step>('invitation')

  // Invitation validation
  const [invitationCode, setInvitationCode] = useState('')

  // Auto-fill invitation code from URL
  useEffect(() => {
    const codeFromUrl = searchParams.get('code')
    if (codeFromUrl) {
      setInvitationCode(codeFromUrl.toUpperCase())
    }
  }, [searchParams])
  const [invitation, setInvitation] = useState<Invitation | null>(null)
  const [validatingCode, setValidatingCode] = useState(false)
  const [codeError, setCodeError] = useState<string | null>(null)

  // Signup form
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

  // Step 1: Validate invitation code
  const handleValidateCode = async (e: FormEvent) => {
    e.preventDefault()
    setCodeError(null)
    setValidatingCode(true)

    try {
      const codeToValidate = invitationCode.trim()

      // Query invitation by code
      const { data, error } = await supabase
        .from('invitations')
        .select('*')
        .eq('code', codeToValidate)
        .maybeSingle()

      // Log the attempt for security monitoring
      const attemptSuccess = !!(data && !data.used_by && (!data.expires_at || new Date(data.expires_at) >= new Date()))
      await supabase
        .from('invitation_attempts')
        .insert({
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

      // Check if already used
      if (data.used_by) {
        setCodeError('This invitation code has already been used.')
        return
      }

      // Check if expired
      if (data.expires_at && new Date(data.expires_at) < new Date()) {
        setCodeError('This invitation code has expired.')
        return
      }

      // Valid! Move to next step
      setInvitation(data)
      setStep('details')
    } catch (err) {
      setCodeError('An unexpected error occurred')
    } finally {
      setValidatingCode(false)
    }
  }

  // Step 2: Create account
  const handleSignup = async (e: FormEvent) => {
    e.preventDefault()
    setSignupError(null)
    setLoading(true)

    try {
      if (!invitation) {
        setSignupError('Invalid invitation')
        return
      }

      // Create auth account
      const { user, error: authError } = await signUp({
        email,
        password,
        options: {
          data: {
            first_name: firstName,
            last_name: lastName,
            avatar_data: avatarData as Record<string, any>,
          },
        },
      })

      if (authError) {
        setSignupError(authError.message)
        return
      }

      if (!user) {
        setSignupError('Failed to create account')
        return
      }

      // Update user profile with avatar data
      const { error: profileError } = await supabase
        .from('users')
        .update({
          first_name: firstName,
          last_name: lastName,
          full_name: `${firstName} ${lastName}`,
          avatar_data: avatarData as unknown as any,
        })
        .eq('id', user.id)

      if (profileError) {
        console.error('Profile update error:', profileError)
        // Don't fail signup, just log it
      }

      // Mark invitation as used
      const { error: invitationError } = await supabase
        .from('invitations')
        .update({
          used_by: user.id,
          used_at: new Date().toISOString(),
        })
        .eq('id', invitation.id)

      if (invitationError) {
        console.error('Invitation update error:', invitationError)
        // Don't fail signup, just log it
      }

      // Add user to trip if invitation has trip_id
      if (invitation.trip_id) {
        const { error: participantError } = await supabase
          .from('trip_participants')
          .insert({
            trip_id: invitation.trip_id,
            user_id: user.id,
            role: 'participant',
          })

        if (participantError) {
          console.error('Participant add error:', participantError)
          // Don't fail signup, just log it
        }
      }

      // Success! Show welcome screen
      setStep('welcome')
    } catch (err) {
      setSignupError('An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }

  // Render based on current step
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
    <div className="min-h-screen bg-gradient-to-br from-sky-50 to-orange-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo/Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">
            🎿 Tim's Super Trip Planner
          </h1>
          <p className="text-gray-600">
            {step === 'invitation'
              ? 'Enter your invitation code to get started'
              : 'Complete your profile'}
          </p>
        </div>

        {/* Step 1: Invitation Code */}
        {step === 'invitation' && (
          <Card>
            <Card.Header>
              <Card.Title>Invitation Required</Card.Title>
              <Card.Description>
                This app is invitation-only. Enter the code provided by Tim.
              </Card.Description>
            </Card.Header>

            <Card.Content>
              <form onSubmit={handleValidateCode} className="space-y-4">
                {codeError && (
                  <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-sm">
                    {codeError}
                  </div>
                )}

                <Input
                  label="Invitation Code"
                  type="text"
                  value={invitationCode}
                  onChange={(e) => setInvitationCode(e.target.value.toUpperCase())}
                  placeholder="ABCD1234"
                  required
                  disabled={validatingCode}
                  helperText="Enter the code exactly as provided (case-insensitive)"
                />

                <Button
                  type="submit"
                  variant="primary"
                  fullWidth
                  isLoading={validatingCode}
                >
                  Continue
                </Button>
              </form>
            </Card.Content>

            <Card.Footer>
              <p className="text-center text-sm text-gray-600">
                Already have an account?{' '}
                <Link
                  to="/login"
                  className="text-sky-600 hover:text-sky-700 font-medium hover:underline"
                >
                  Sign in
                </Link>
              </p>
            </Card.Footer>
          </Card>
        )}

        {/* Step 2: Account Details + Avatar */}
        {step === 'details' && (
          <Card>
            <Card.Header>
              <Card.Title>Create Your Account</Card.Title>
              <Card.Description>
                Set up your profile and choose your avatar
              </Card.Description>
            </Card.Header>

            <Card.Content>
              <form onSubmit={handleSignup} className="space-y-6">
                {signupError && (
                  <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-sm">
                    {signupError}
                  </div>
                )}

                {/* Email */}
                <Input
                  label="Email"
                  type="email"
                  value={email}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
                  placeholder="tim@example.com"
                  required
                  disabled={loading}
                />

                {/* Password */}
                <Input
                  label="Password"
                  type="password"
                  value={password}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  disabled={loading}
                  helperText="Minimum 6 characters"
                />

                {/* First Name */}
                <Input
                  label="First Name"
                  type="text"
                  value={firstName}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFirstName(e.target.value)}
                  placeholder="Tim"
                  required
                  disabled={loading}
                />

                {/* Last Name */}
                <Input
                  label="Last Name"
                  type="text"
                  value={lastName}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLastName(e.target.value)}
                  placeholder="Lam"
                  required
                  disabled={loading}
                />

                {/* Avatar Builder */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-3">
                    Choose Your Avatar
                  </label>
                  <AvatarBuilder
                    value={avatarData}
                    onChange={setAvatarData}
                    disabled={loading}
                  />
                </div>

                {/* Buttons */}
                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setStep('invitation')}
                    disabled={loading}
                  >
                    Back
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    fullWidth
                    isLoading={loading}
                  >
                    Create Account
                  </Button>
                </div>
              </form>
            </Card.Content>
          </Card>
        )}

        {/* Footer Note */}
        {step === 'invitation' && (
          <p className="text-center text-xs text-gray-500 mt-6">
            Don't have an invitation code? Contact Tim.
          </p>
        )}
      </div>
    </div>
  )
}
