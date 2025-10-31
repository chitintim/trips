import { createClient, SupabaseClient, User, Session, AuthError } from '@supabase/supabase-js'
import { Database } from '../types/database.types'

// Re-export Database type for convenience
export type { Database }

// Environment variables
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables. Please check your .env file.')
}

// Create and export the Supabase client with proper typing
export const supabase: SupabaseClient<Database> = createClient<Database>(
  supabaseUrl,
  supabaseAnonKey
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
