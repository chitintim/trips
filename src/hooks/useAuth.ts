import { useEffect, useState } from 'react'
import { supabase, AuthState, SignUpCredentials, SignInCredentials } from '../lib/supabase'

export function useAuth() {
  const [authState, setAuthState] = useState<AuthState>({
    user: null,
    session: null,
    loading: true,
  })

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setAuthState({
        user: session?.user ?? null,
        session: session,
        loading: false,
      })
    })

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthState({
        user: session?.user ?? null,
        session: session,
        loading: false,
      })
    })

    return () => subscription.unsubscribe()
  }, [])

  const signUp = async (credentials: SignUpCredentials) => {
    const { data, error } = await supabase.auth.signUp({
      email: credentials.email,
      password: credentials.password,
      options: {
        ...credentials.options,
        emailRedirectTo: `${window.location.origin}/trips/`,
      },
    })
    return { user: data.user, session: data.session, error }
  }

  const signIn = async (credentials: SignInCredentials) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: credentials.email,
      password: credentials.password,
    })
    return { user: data.user, session: data.session, error }
  }

  const signOut = async () => {
    const { error } = await supabase.auth.signOut()
    // Ignore "Auth session missing" error - user is already signed out
    if (error && error.message?.includes('Auth session missing')) {
      return { error: null }
    }
    return { error }
  }

  const resetPassword = async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/trips/reset-password`,
    })
    return { error }
  }

  /**
   * "Email me a code": send a 6-digit OTP to an existing account's email.
   * `shouldCreateUser: false` so this never silently creates a new
   * unregistered account from the login screen (invitation-only signup
   * stays the only way to create a user).
   */
  const requestEmailOtp = async (email: string) => {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    })
    return { error }
  }

  /** Verify the 6-digit code sent by requestEmailOtp, completing sign-in. */
  const verifyEmailOtp = async (email: string, token: string) => {
    const { data, error } = await supabase.auth.verifyOtp({ email, token, type: 'email' })
    return { user: data.user, session: data.session, error }
  }

  /**
   * OTP-first invitation signup: send a code to an email that does NOT
   * have an account yet (shouldCreateUser: true creates the auth user on
   * verify, without requiring a password).
   */
  const requestSignupOtp = async (email: string) => {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    })
    return { error }
  }

  return {
    user: authState.user,
    session: authState.session,
    loading: authState.loading,
    signUp,
    signIn,
    signOut,
    resetPassword,
    requestEmailOtp,
    verifyEmailOtp,
    requestSignupOtp,
  }
}
