import { useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'

/**
 * Component that detects auth callbacks from email links and redirects appropriately
 * Supabase sends users back to the site URL with hash parameters like:
 * #access_token=...&type=recovery (for password reset)
 * #access_token=...&type=signup (for email confirmation)
 */
export function AuthCallback() {
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    // Check if there's a hash in the URL
    if (location.hash) {
      // Parse the hash parameters
      const hashParams = new URLSearchParams(location.hash.substring(1))
      const type = hashParams.get('type')
      const accessToken = hashParams.get('access_token')

      // Handle different auth callback types
      if (type === 'recovery') {
        // Password recovery - redirect to reset password page (only if not already there)
        if (location.pathname !== '/reset-password') {
          // Preserve the hash when redirecting
          navigate('/reset-password' + location.hash, { replace: true })
        }
      } else if (type === 'signup' && accessToken) {
        // Email confirmation - redirect to dashboard
        navigate('/', { replace: true })
      }
      // Add other types as needed
    }
  }, [location.hash, location.pathname, navigate])

  return null
}
