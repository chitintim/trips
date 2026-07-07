import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import { ProtectedRoute } from './components/ProtectedRoute'
import { AuthCallback } from './components/AuthCallback'
import { InstallPrompt } from './components/InstallPrompt'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ToastProvider } from './components/ui'
import { authRoutes } from './features/auth/routes'
import { ClaimPage } from './features/expenses'
import { Dashboard } from './pages/Dashboard'
import { TripDetail } from './pages/TripDetail'
import { SharePage } from './pages/SharePage'

function App() {
  return (
    <ToastProvider>
      <Router basename={import.meta.env.BASE_URL.replace(/\/$/, '') || '/'}>
        <AuthCallback />
        <InstallPrompt />
        <ErrorBoundary label="the app">
          <Routes>
            {/* Public Routes (owned by the auth feature, see features/auth/routes.tsx) */}
            {authRoutes}

            {/* Protected Routes */}
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <Dashboard />
                </ProtectedRoute>
              }
            />
            <Route path="/dashboard" element={<Navigate to="/" replace />} />

            {/* Claim Items Route (owned by the expenses feature) */}
            <Route
              path="/claim/:code"
              element={
                <ProtectedRoute>
                  <ClaimPage />
                </ProtectedRoute>
              }
            />

            {/* Share target landing (UX_REDESIGN.md Part 3 "Ambient AI" #1) */}
            <Route
              path="/share"
              element={
                <ProtectedRoute>
                  <SharePage />
                </ProtectedRoute>
              }
            />

            {/* Trip Detail Route */}
            <Route
              path="/:tripId"
              element={
                <ProtectedRoute>
                  <TripDetail />
                </ProtectedRoute>
              }
            />

            {/* Catch all - redirect to home */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ErrorBoundary>
      </Router>
    </ToastProvider>
  )
}

export default App
