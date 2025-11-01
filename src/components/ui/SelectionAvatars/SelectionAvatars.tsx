import { HTMLAttributes } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface SelectionAvatarsProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Array of selections with user data
   */
  selections: Array<{
    id: string
    user?: {
      full_name?: string
      email?: string
      avatar_data?: {
        emoji: string
        bgColor: string
      }
    }
  }>

  /**
   * Maximum number of avatars to show before overflow
   * @default 3
   */
  maxAvatars?: number

  /**
   * Avatar size
   * @default 'md'
   */
  size?: 'sm' | 'md' | 'lg'

  /**
   * Show labels with names
   * @default false
   */
  showLabels?: boolean
}

// ============================================================================
// COMPONENT
// ============================================================================

export function SelectionAvatars({
  selections,
  maxAvatars = 3,
  size = 'md',
  showLabels = false,
  className = '',
  ...props
}: SelectionAvatarsProps) {
  const visibleSelections = selections.slice(0, maxAvatars)
  const overflowCount = Math.max(0, selections.length - maxAvatars)

  // Size classes
  const sizeClasses = {
    sm: {
      avatar: 'w-6 h-6 text-xs',
      overflow: 'w-6 h-6 text-xs',
      label: 'text-xs',
    },
    md: {
      avatar: 'w-8 h-8 text-sm',
      overflow: 'w-8 h-8 text-xs',
      label: 'text-sm',
    },
    lg: {
      avatar: 'w-10 h-10 text-base',
      overflow: 'w-10 h-10 text-sm',
      label: 'text-base',
    },
  }

  const classes = sizeClasses[size]

  if (selections.length === 0) {
    return null
  }

  return (
    <div className={`flex items-center gap-2 ${className}`} {...props}>
      {/* Avatar List */}
      <div className="flex items-center -space-x-2">
        {visibleSelections.map((selection) => {
          const user = selection.user
          const emoji = (user?.avatar_data as any)?.emoji || '😊'
          const bgColor = (user?.avatar_data as any)?.bgColor || '#0ea5e9'
          const displayName = user?.full_name || user?.email || 'Unknown'

          return (
            <div
              key={selection.id}
              className={`${classes.avatar} rounded-full flex items-center justify-center ring-2 ring-white transition-transform hover:scale-110 hover:z-10 cursor-default`}
              style={{ backgroundColor: bgColor }}
              title={displayName}
            >
              {emoji}
            </div>
          )
        })}

        {/* Overflow Badge */}
        {overflowCount > 0 && (
          <div
            className={`${classes.overflow} rounded-full flex items-center justify-center bg-gray-200 text-gray-700 font-medium ring-2 ring-white cursor-default`}
            title={`+${overflowCount} more ${overflowCount === 1 ? 'person' : 'people'}`}
          >
            +{overflowCount}
          </div>
        )}
      </div>

      {/* Optional Labels */}
      {showLabels && (
        <div className={`${classes.label} text-gray-600`}>
          {visibleSelections.length === 1 && selections.length === 1 ? (
            <span>{visibleSelections[0].user?.full_name || visibleSelections[0].user?.email}</span>
          ) : (
            <span>
              {selections.length} {selections.length === 1 ? 'person' : 'people'}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

SelectionAvatars.displayName = 'SelectionAvatars'
