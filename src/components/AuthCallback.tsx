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

      // Handle different auth callback types
      if (type === 'recovery') {
        // Password recovery - redirect to reset password page
        navigate('/reset-password', { replace: true })
      }
      // Add other types as needed (signup confirmation, etc.)
    }
  }, [location.hash, navigate])

  return null
}
