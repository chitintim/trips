import { HTMLAttributes } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface CapacityProgressBarProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Number of confirmed participants
   */
  confirmedCount: number

  /**
   * Maximum capacity (null = unlimited)
   */
  capacityLimit: number | null

  /**
   * Number of interested participants (shown as lighter color on bar)
   */
  interestedCount?: number

  /**
   * Number of conditional participants (shown as lighter color on bar)
   */
  conditionalCount?: number

  /**
   * Number of participants on waitlist
   */
  waitlistCount?: number

  /**
   * Show detailed text below the bar
   */
  showDetails?: boolean

  /**
   * Size of the progress bar
   */
  size?: 'sm' | 'md' | 'lg'
}

// ============================================================================
// COMPONENT
// ============================================================================

export function CapacityProgressBar({
  confirmedCount,
  capacityLimit,
  interestedCount = 0,
  conditionalCount = 0,
  waitlistCount = 0,
  showDetails = true,
  size = 'md',
  className = '',
  ...props
}: CapacityProgressBarProps) {
  // Calculate percentages
  const confirmedPercentage = capacityLimit
    ? Math.min(100, (confirmedCount / capacityLimit) * 100)
    : 0

  const pipelineTotal = confirmedCount + (interestedCount || 0) + conditionalCount
  const pipelinePercentage = capacityLimit
    ? Math.min(100, (pipelineTotal / capacityLimit) * 100)
    : 0

  // Determine color based on capacity
  const getBarColor = () => {
    if (!capacityLimit) return 'bg-primary-500'
    if (confirmedCount >= capacityLimit) return 'bg-error-500'
    if (confirmedPercentage >= 80) return 'bg-warning-500'
    return 'bg-success-500'
  }

  const getBarBgColor = () => {
    if (!capacityLimit) return 'bg-primary-100'
    if (confirmedCount >= capacityLimit) return 'bg-error-100'
    if (confirmedPercentage >= 80) return 'bg-warning-100'
    return 'bg-success-100'
  }

  const getPipelineColor = () => {
    if (!capacityLimit) return 'bg-primary-300'
    if (confirmedCount >= capacityLimit) return 'bg-error-300'
    if (confirmedPercentage >= 80) return 'bg-warning-300'
    return 'bg-success-300'
  }

  // Size classes
  const sizeClasses = {
    sm: 'h-1.5',
    md: 'h-2',
    lg: 'h-3',
  }

  const textSizeClasses = {
    sm: 'text-xs',
    md: 'text-sm',
    lg: 'text-base',
  }

  const spotsRemaining = capacityLimit ? Math.max(0, capacityLimit - confirmedCount) : null
  const isFull = capacityLimit && confirmedCount >= capacityLimit

  return (
    <div className={`space-y-2 ${className}`} {...props}>
      {/* Progress Bar */}
      <div className="space-y-1.5">
        {/* Bar */}
        {capacityLimit && (
          <div className={`relative w-full ${getBarBgColor()} rounded-full overflow-hidden ${sizeClasses[size]}`}>
            {/* Pipeline (conditional) - lighter color */}
            {conditionalCount > 0 && (
              <div
                className={`absolute inset-y-0 left-0 ${getPipelineColor()} rounded-full transition-all duration-300 ease-out`}
                style={{ width: `${pipelinePercentage}%` }}
              />
            )}
            {/* Confirmed - solid color on top */}
            <div
              className={`relative ${getBarColor()} ${sizeClasses[size]} rounded-full transition-all duration-300 ease-out`}
              style={{ width: `${confirmedPercentage}%` }}
            />
          </div>
        )}

        {/* Simplified text - single line */}
        <div className={`flex items-center justify-between ${textSizeClasses[size]}`}>
          <span className="font-medium text-gray-900">
            {capacityLimit ? (
              <>
                {confirmedCount}/{capacityLimit} confirmed
                {isFull && ' · Full'}
                {!isFull && spotsRemaining !== null && ` · ${spotsRemaining} ${spotsRemaining === 1 ? 'spot' : 'spots'} left`}
              </>
            ) : (
              <>{confirmedCount} confirmed · No limit</>
            )}
          </span>
          {conditionalCount > 0 && (
            <span className="text-sm text-gray-500">
              +{conditionalCount} conditional
            </span>
          )}
        </div>

        {/* Waitlist indicator */}
        {waitlistCount > 0 && (
          <div className="text-xs text-gray-500">
            {waitlistCount} on waitlist
          </div>
        )}
      </div>
    </div>
  )
}

CapacityProgressBar.displayName = 'CapacityProgressBar'
