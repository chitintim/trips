import { HTMLAttributes } from 'react'
import { Database } from '../../../types/database.types'
import { SelectionAvatars } from '../SelectionAvatars'

// ============================================================================
// TYPES
// ============================================================================

type ConditionalType = Database['public']['Enums']['conditional_type']

export interface ConditionalDependencyDisplayProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Type of conditional
   */
  conditionalType: ConditionalType

  /**
   * Date condition (if applicable)
   */
  conditionalDate?: string | null

  /**
   * User IDs that this confirmation depends on
   */
  conditionalUserIds?: string[] | null

  /**
   * All participants (to look up user details)
   */
  participants?: Array<{
    user_id: string
    confirmation_status?: string
    user?: {
      id: string
      full_name?: string
      email?: string
      avatar_data?: any
    }
  }>

  /**
   * Whether conditions are currently met
   */
  conditionsMet?: boolean

  /**
   * Show compact version
   */
  compact?: boolean

  /**
   * Size variant
   */
  size?: 'sm' | 'md' | 'lg'
}

// ============================================================================
// COMPONENT
// ============================================================================

export function ConditionalDependencyDisplay({
  conditionalType,
  conditionalDate,
  conditionalUserIds,
  participants = [],
  conditionsMet,
  compact = false,
  size = 'md',
  className = '',
  ...props
}: ConditionalDependencyDisplayProps) {
  // If no conditions, return null
  if (conditionalType === 'none' || conditionalType === null) {
    return null
  }

  // Find dependent users
  const dependentUsers = conditionalUserIds
    ?.map((userId) => participants.find((p) => p.user_id === userId))
    .filter((p) => p !== undefined) || []

  // Format date
  const formattedDate = conditionalDate
    ? new Date(conditionalDate).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : null

  // Check if date has passed
  const datePassed = conditionalDate
    ? new Date(conditionalDate) < new Date()
    : false

  // Check if all users are confirmed
  const allUsersConfirmed = dependentUsers.length > 0 &&
    dependentUsers.every((p) => p?.confirmation_status === 'confirmed')

  // Size classes
  const sizeClasses = {
    sm: 'text-xs',
    md: 'text-sm',
    lg: 'text-base',
  }

  const iconSizeClasses = {
    sm: 'w-3.5 h-3.5',
    md: 'w-4 h-4',
    lg: 'w-5 h-5',
  }

  // Render date condition
  const renderDateCondition = () => {
    if (!conditionalDate) return null

    return (
      <div className="flex items-start gap-2">
        <div className={`${iconSizeClasses[size]} flex-shrink-0 mt-0.5 ${datePassed ? 'text-error-500' : 'text-warning-500'}`}>
          <svg fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clipRule="evenodd" />
          </svg>
        </div>
        <div className="flex-1">
          <div className={`${sizeClasses[size]} text-gray-700`}>
            {datePassed ? (
              <span className="text-error-600 font-medium">Date passed: {formattedDate}</span>
            ) : (
              <span>Will confirm by <span className="font-medium">{formattedDate}</span></span>
            )}
          </div>
          {!compact && !datePassed && (
            <div className="text-xs text-gray-500 mt-0.5">
              {Math.ceil((new Date(conditionalDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))} days remaining
            </div>
          )}
        </div>
      </div>
    )
  }

  // Render user dependencies
  const renderUserDependencies = () => {
    if (!conditionalUserIds || conditionalUserIds.length === 0) return null

    // Convert to selections format for SelectionAvatars
    const selections = dependentUsers.map((p) => ({
      id: p!.user_id,
      user: p!.user,
    }))

    return (
      <div className="flex items-start gap-2">
        <div className={`${iconSizeClasses[size]} flex-shrink-0 mt-0.5 ${allUsersConfirmed ? 'text-success-500' : 'text-warning-500'}`}>
          <svg fill="currentColor" viewBox="0 0 20 20">
            <path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z" />
          </svg>
        </div>
        <div className="flex-1">
          <div className={`${sizeClasses[size]} text-gray-700 mb-1.5`}>
            {allUsersConfirmed ? (
              <span className="text-success-600 font-medium">All required users confirmed</span>
            ) : (
              <span>Waiting for confirmation from:</span>
            )}
          </div>
          {!compact && selections.length > 0 && (
            <div className="flex items-center gap-2">
              <SelectionAvatars
                selections={selections}
                maxAvatars={5}
                size={size === 'lg' ? 'md' : 'sm'}
              />
              <div className="text-xs text-gray-600">
                {selections.map((s, i) => (
                  <span key={s.id}>
                    {s.user?.full_name || s.user?.email || 'Unknown'}
                    {i < selections.length - 1 && ', '}
                  </span>
                ))}
              </div>
            </div>
          )}
          {!compact && !allUsersConfirmed && dependentUsers.length > 0 && (
            <div className="text-xs text-gray-500 mt-1">
              {dependentUsers.filter((p) => p?.confirmation_status === 'confirmed').length}/{dependentUsers.length} confirmed
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={`space-y-3 ${className}`} {...props}>
      {/* Conditions Met Indicator (if provided) */}
      {conditionsMet !== undefined && (
        <div className={`flex items-center gap-2 ${sizeClasses[size]}`}>
          {conditionsMet ? (
            <>
              <div className={`${iconSizeClasses[size]} text-success-500`}>
                <svg fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
              </div>
              <span className="text-success-600 font-medium">Conditions met - ready to confirm!</span>
            </>
          ) : (
            <>
              <div className={`${iconSizeClasses[size]} text-warning-500`}>
                <svg fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
                </svg>
              </div>
              <span className="text-warning-600 font-medium">Waiting for conditions to be met</span>
            </>
          )}
        </div>
      )}

      {/* Date Condition */}
      {(conditionalType === 'date' || conditionalType === 'both') && renderDateCondition()}

      {/* OR Divider for 'both' type */}
      {conditionalType === 'both' && (
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-gray-300" />
          <span className={`${sizeClasses[size]} text-gray-500 font-medium uppercase`}>OR</span>
          <div className="flex-1 h-px bg-gray-300" />
        </div>
      )}

      {/* User Dependencies */}
      {(conditionalType === 'users' || conditionalType === 'both') && renderUserDependencies()}

      {/* Explanation for 'both' type */}
      {conditionalType === 'both' && !compact && (
        <div className={`${sizeClasses[size]} text-gray-500 italic border-l-2 border-gray-300 pl-3`}>
          Will confirm when either the date arrives or all required users confirm
        </div>
      )}
    </div>
  )
}

ConditionalDependencyDisplay.displayName = 'ConditionalDependencyDisplay'
