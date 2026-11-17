import { createClient, SupabaseClient, User, Session, AuthError } from '@supabase/supabase-js'
import { Database } from '../types/database.types'
import { CLIENT_INFO } from './appVersion'

// Re-export Database type for convenience
export type { Database }

// Environment variables
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables. Please check your .env file.')
}

// Create and export the Supabase client with proper typing. The build id rides in the EXISTING X-Client-Info header (PostgREST exposes
// it to the database as request.headers, so old builds can be told apart from new ones). Do NOT add a new header name: browsers
// preflight it and every edge function's CORS allow-list (supabase/functions/_shared/cors.ts) would have to list it, or every
// functions.invoke call would fail.
export const supabase: SupabaseClient<Database> = createClient<Database>(
  supabaseUrl,
  supabaseAnonKey,
  { global: { headers: { 'X-Client-Info': CLIENT_INFO } } }
)

// Auth-related types
export type { User, Session, AuthError }

export interface AuthState {
  user: User | null
  session: Session | null
  loading: boolean
}

export interface SignUpCredentials {
  email: string
  password: string
  options?: {
    data?: {
      [key: string]: any
    }
  }
}

export interface SignInCredentials {
  email: string
  password: string
}

export interface AuthResponse {
  user: User | null
  session: Session | null
  error: AuthError | null
}
