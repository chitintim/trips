import { useAuth } from '../hooks/useAuth'
import { Button, Card, EmptyState } from '../components/ui'

export function Dashboard() {
  const { user, signOut } = useAuth()

  const handleSignOut = async () => {
    await signOut()
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-sky-50 to-orange-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🎿</span>
              <h1 className="text-xl font-bold text-gray-900">
                Ski Trip Planner
              </h1>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-600">
                {user?.email}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={handleSignOut}
              >
                Sign Out
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">
            Welcome Back! 👋
          </h2>
          <p className="text-gray-600">
            Your ski trips and adventures await
          </p>
        </div>

        {/* Empty State - No trips yet */}
        <Card>
          <Card.Content className="py-12">
            <EmptyState
              icon="🎿"
              title="No trips yet"
              description="You haven't been added to any trips yet. Your trip organizer will add you soon!"
            />
          </Card.Content>
        </Card>

        {/* Coming Soon Notice */}
        <div className="mt-8 bg-sky-50 border border-sky-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <span className="text-2xl">⚠️</span>
            <div>
              <h3 className="font-semibold text-sky-900 mb-1">
                Dashboard Under Construction
              </h3>
              <p className="text-sm text-sky-800">
                We're building out the full trip dashboard. Soon you'll be able to view trips,
                make selections, track expenses, and collaborate with your group!
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
