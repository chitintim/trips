import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { AnyAvatarData, User, Trip } from '../types'
import { Avatar, Button, Spinner, UserAvatar } from './ui'

interface WelcomeProps {
  firstName: string
  /**
   * Avatar system v2 (UX_REDESIGN.md "Avatar system v2"): whichever of
   * photo/icon/emoji the signup avatar picker produced, resolved the same
   * way as everywhere else via the shared `Avatar` component -- this used
   * to be a bespoke emoji-only renderer that couldn't show a photo or
   * curated icon even though Signup could produce either.
   */
  avatarUrl?: string | null
  avatarData?: AnyAvatarData | null
  tripId?: string | null
  onContinue: () => void
}

interface Participant {
  user: User
}

export function Welcome({ firstName, avatarUrl, avatarData, tripId, onContinue }: WelcomeProps) {
  const [trip, setTrip] = useState<Trip | null>(null)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [loading, setLoading] = useState(true)
  const [showContent, setShowContent] = useState(false)

  useEffect(() => {
    // Fade in animation
    const timer = setTimeout(() => setShowContent(true), 300)

    // Fetch trip and participants if tripId exists
    const fetchTripData = async () => {
      if (!tripId) {
        setLoading(false)
        return
      }

      try {
        // Fetch trip
        const { data: tripData } = await supabase
          .from('trips')
          .select('*')
          .eq('id', tripId)
          .single()

        if (tripData) {
          setTrip(tripData)
        }

        // Fetch other participants (excluding current user)
        const { data: participantsData } = await supabase
          .from('trip_participants')
          .select('user:users(*)')
          .eq('trip_id', tripId)
          .limit(5)

        if (participantsData) {
          setParticipants(participantsData as Participant[])
        }
      } catch (error) {
        console.error('Error fetching trip data:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchTripData()

    return () => clearTimeout(timer)
  }, [tripId])

  // Format display name
  const getDisplayName = (user: User) => {
    if (user.first_name) {
      return user.first_name.length > 12 ? user.first_name.slice(0, 10) + '...' : user.first_name
    }
    return user.email.split('@')[0]
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-sky-50 to-orange-50 flex items-center justify-center p-4">
      <div
        className={`
          w-full max-w-lg transition-all duration-700 transform
          ${showContent ? 'opacity-100 scale-100' : 'opacity-0 scale-95'}
        `}
      >
        {/* Main Welcome Card */}
        <div className="bg-white rounded-2xl shadow-xl p-8 text-center">
          {/* Animated Avatar */}
          <div className="flex justify-center mb-6 animate-bounce-slow">
            <Avatar
              size="2xl"
              avatarUrl={avatarUrl}
              avatarData={avatarData}
              alt={firstName || 'Your avatar'}
              fallback={firstName ? firstName.charAt(0) : undefined}
            />
          </div>

          {/* Welcome Message */}
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Welcome, {firstName}! 🎉
          </h1>

          {loading ? (
            <div className="py-8">
              <Spinner size="md" />
              <p className="text-gray-600 mt-4">Loading your trip details...</p>
            </div>
          ) : trip ? (
            <>
              <p className="text-gray-600 mb-6">
                You're joining friends on
              </p>

              {/* Trip Info */}
              <div className="bg-gradient-to-r from-sky-100 to-orange-100 rounded-xl p-4 mb-6">
                <h2 className="text-xl font-bold text-gray-900 mb-1">
                  {trip.name}
                </h2>
                <p className="text-sm text-gray-700">
                  📍 {trip.location}
                </p>
                <p className="text-xs text-gray-600 mt-1">
                  {new Date(trip.start_date).toLocaleDateString()} - {new Date(trip.end_date).toLocaleDateString()}
                </p>
              </div>

              {/* Participants */}
              {participants.length > 0 && (
                <div className="mb-8">
                  <p className="text-sm font-medium text-gray-700 mb-3">
                    You'll be traveling with:
                  </p>
                  <div className="flex flex-wrap justify-center gap-4">
                    {participants.slice(0, 5).map((participant) => (
                      <div
                        key={participant.user.id}
                        className="flex flex-col items-center gap-1"
                      >
                        <UserAvatar avatarData={participant.user} size="sm" alt={getDisplayName(participant.user)} />
                        <span className="text-xs font-medium text-gray-700">
                          {getDisplayName(participant.user)}
                        </span>
                      </div>
                    ))}
                    {participants.length > 5 && (
                      <div className="flex flex-col items-center gap-1">
                        <div className="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center text-sm font-medium text-gray-600">
                          +{participants.length - 5}
                        </div>
                        <span className="text-xs font-medium text-gray-700">
                          more
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-gray-600 mb-8">
              Your account has been created successfully!
            </p>
          )}

          {/* Email Verification Notice */}
          <div className="bg-sky-50 border border-sky-200 rounded-lg p-4 mb-6">
            <div className="flex items-start gap-3">
              <span className="text-2xl">📧</span>
              <div className="text-left flex-1">
                <p className="text-sm font-medium text-sky-900 mb-1">
                  Check your inbox
                </p>
                <p className="text-xs text-sky-700">
                  We've sent you a verification email. Please check your inbox and click the link to verify your account.
                </p>
              </div>
            </div>
          </div>

          {/* Continue Button */}
          <Button
            variant="primary"
            size="lg"
            fullWidth
            onClick={onContinue}
          >
            Got it! 👍
          </Button>
        </div>

        {/* Snowflake decoration */}
        <div className="text-center mt-6 text-4xl animate-pulse opacity-50">
          ❄️ ❄️ ❄️
        </div>
      </div>

      <style>{`
        @keyframes bounce-slow {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-10px); }
        }
        .animate-bounce-slow {
          animation: bounce-slow 2s ease-in-out infinite;
        }
      `}</style>
    </div>
  )
}
