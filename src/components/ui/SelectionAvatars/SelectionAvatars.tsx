import { HTMLAttributes, useState, useRef, useEffect } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface SelectionAvatarsProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Array of selections with user data
   */
  selections: Array<{
    id: string
    selected_at?: string
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
  const [showPopover, setShowPopover] = useState(false)
  const [popoverPosition, setPopoverPosition] = useState<'center' | 'left' | 'right'>('center')
  const popoverRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLDivElement>(null)

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

  // Calculate popover position to avoid going off-screen
  useEffect(() => {
    if (showPopover && buttonRef.current) {
      const buttonRect = buttonRef.current.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const popoverWidth = 288 // w-72 = 18rem = 288px

      // Check if there's enough space on the left and right
      const spaceOnLeft = buttonRect.left
      const spaceOnRight = viewportWidth - buttonRect.right

      if (spaceOnLeft < popoverWidth / 2 && spaceOnRight >= popoverWidth) {
        setPopoverPosition('left')
      } else if (spaceOnRight < popoverWidth / 2 && spaceOnLeft >= popoverWidth) {
        setPopoverPosition('right')
      } else {
        setPopoverPosition('center')
      }
    }
  }, [showPopover])

  // Close popover when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        showPopover &&
        popoverRef.current &&
        buttonRef.current &&
        !popoverRef.current.contains(event.target as Node) &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setShowPopover(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('touchstart', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('touchstart', handleClickOutside)
    }
  }, [showPopover])

  // Format timestamp
  const formatTimestamp = (timestamp?: string) => {
    if (!timestamp) return 'Unknown'

    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
    const diffMinutes = Math.floor(diffMs / (1000 * 60))

    if (diffMinutes < 1) return 'Just now'
    if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`
    if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`

    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  // Sort selections by most recent first
  const sortedSelections = [...selections].sort((a, b) => {
    const dateA = a.selected_at ? new Date(a.selected_at).getTime() : 0
    const dateB = b.selected_at ? new Date(b.selected_at).getTime() : 0
    return dateB - dateA
  })

  if (selections.length === 0) {
    return null
  }

  return (
    <div className={`relative flex items-center gap-2 ${className}`} {...props}>
      {/* Avatar List - Clickable */}
      <div
        ref={buttonRef}
        className="flex items-center -space-x-2 cursor-pointer hover:opacity-80 transition-opacity"
        onClick={() => setShowPopover(!showPopover)}
        role="button"
        aria-label="View all selections"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setShowPopover(!showPopover)
          }
        }}
      >
        {visibleSelections.map((selection) => {
          const user = selection.user
          const emoji = (user?.avatar_data as any)?.emoji || '😊'
          const accessory = (user?.avatar_data as any)?.accessory
          const bgColor = (user?.avatar_data as any)?.bgColor || '#0ea5e9'
          const displayName = user?.full_name || user?.email || 'Unknown'

          return (
            <div
              key={selection.id}
              className={`${classes.avatar} rounded-full flex flex-col items-center justify-center ring-2 ring-white`}
              style={{ backgroundColor: bgColor }}
              title={displayName}
            >
              {accessory && (
                <span className="text-xs -mb-1">
                  {accessory}
                </span>
              )}
              <span>
                {emoji}
              </span>
            </div>
          )
        })}

        {/* Overflow Badge */}
        {overflowCount > 0 && (
          <div
            className={`${classes.overflow} rounded-full flex items-center justify-center bg-gray-200 text-gray-700 font-medium ring-2 ring-white`}
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

      {/* Popover */}
      {showPopover && (
        <div
          ref={popoverRef}
          className="absolute z-popover mt-2 w-72 bg-white rounded-lg shadow-xl border border-gray-200 max-h-96 overflow-y-auto"
          style={{
            top: '100%',
            left: popoverPosition === 'left' ? '0' : popoverPosition === 'right' ? 'auto' : '50%',
            right: popoverPosition === 'right' ? '0' : 'auto',
            transform: popoverPosition === 'center' ? 'translateX(-50%)' : 'none',
          }}
        >
          {/* Header */}
          <div className="sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between rounded-t-lg">
            <h3 className="text-sm font-semibold text-gray-900">
              Who selected this ({selections.length})
            </h3>
            <button
              onClick={() => setShowPopover(false)}
              className="text-gray-400 hover:text-gray-600 transition-colors p-1"
              aria-label="Close"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* List */}
          <div className="py-2">
            {sortedSelections.map((selection) => {
              const user = selection.user
              const emoji = (user?.avatar_data as any)?.emoji || '😊'
              const accessory = (user?.avatar_data as any)?.accessory
              const bgColor = (user?.avatar_data as any)?.bgColor || '#0ea5e9'
              const displayName = user?.full_name || user?.email || 'Unknown'

              return (
                <div
                  key={selection.id}
                  className="px-4 py-3 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="w-10 h-10 rounded-full flex flex-col items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: bgColor }}
                    >
                      {accessory && (
                        <span className="text-xs -mb-1">
                          {accessory}
                        </span>
                      )}
                      <span className="text-base">
                        {emoji}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate">
                        {displayName}
                      </div>
                      <div className="text-xs text-gray-500">
                        {formatTimestamp(selection.selected_at)}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

SelectionAvatars.displayName = 'SelectionAvatars'
