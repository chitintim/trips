import { Navigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { Spinner } from './ui'

interface ProtectedRouteProps {
  children: React.ReactNode
  requireAdmin?: boolean
}

export function ProtectedRoute({ children, requireAdmin = false }: ProtectedRouteProps) {
  const { user, loading } = useAuth()

  // Show loading spinner while checking auth
  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-sky-50 to-orange-50 flex items-center justify-center">
        <div className="text-center">
          <Spinner size="lg" />
          <p className="text-gray-600 mt-4">Loading...</p>
        </div>
      </div>
    )
  }

  // Redirect to login if not authenticated
  if (!user) {
    return <Navigate to="/login" replace />
  }

  // TODO: Check admin role when we implement admin features
  // For now, just check if user exists
  if (requireAdmin) {
    // Will implement admin check later with user profile data
    // const isAdmin = user?.app_metadata?.role === 'admin'
    // if (!isAdmin) return <Navigate to="/" replace />
  }

  return <>{children}</>
}
