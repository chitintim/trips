import { HTMLAttributes, ImgHTMLAttributes, forwardRef, useState } from 'react'
import type { AvatarData } from '../../../types'

// ============================================================================
// TYPES
// ============================================================================

export type { AvatarData }

export interface AvatarProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  /**
   * Image source URL
   */
  src?: string

  /**
   * Fallback text (usually initials) if image fails to load
   */
  fallback?: string

  /**
   * Emoji avatar_data contract (preferred for this app's users).
   * When provided, renders the emoji + accessory + bgColor combo used
   * throughout the app instead of an image/initials.
   */
  avatarData?: AvatarData | Partial<AvatarData> | null

  /**
   * Alt text for the image
   */
  alt?: string

  /**
   * Size of the avatar
   */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'

  /**
   * Shape of the avatar
   */
  shape?: 'circle' | 'square'
}

// ============================================================================
// COMPONENT
// ============================================================================

const sizeStyles = {
  xs: 'w-6 h-6 text-xs',
  sm: 'w-8 h-8 text-sm',
  md: 'w-10 h-10 text-base',
  lg: 'w-12 h-12 text-lg',
  xl: 'w-16 h-16 text-xl',
  '2xl': 'w-20 h-20 text-2xl',
}

const shapeStyles = {
  circle: 'rounded-full',
  square: 'rounded-[var(--radius-md)]',
}

export const Avatar = forwardRef<HTMLImageElement, AvatarProps>(
  (
    {
      src,
      fallback,
      avatarData,
      alt = 'Avatar',
      size = 'md',
      shape = 'circle',
      className = '',
      ...props
    },
    ref
  ) => {
    const [imageError, setImageError] = useState(false)

    const baseStyles = `
      inline-flex
      items-center
      justify-center
      overflow-hidden
      text-white
      font-semibold
      select-none
      shrink-0
    `

    const combinedClasses = `
      ${baseStyles}
      ${sizeStyles[size]}
      ${shapeStyles[shape]}
      ${className}
    `.trim().replace(/\s+/g, ' ')

    // Emoji avatar_data contract takes priority (this app's primary avatar style)
    if (avatarData) {
      return (
        <div
          className={`${combinedClasses} flex-col bg-accent-500`}
          style={{ backgroundColor: avatarData.bgColor || undefined }}
          role="img"
          aria-label={alt}
        >
          {avatarData.accessory && (
            <span className="text-[0.6em] leading-none -mb-1" aria-hidden="true">
              {avatarData.accessory}
            </span>
          )}
          <span>{avatarData.emoji || '🙂'}</span>
        </div>
      )
    }

    const showFallback = !src || imageError

    return (
      <div className={`${combinedClasses} bg-gradient-to-br from-accent-400 to-accent-600`}>
        {showFallback ? (
          <span className="uppercase">
            {fallback || alt.charAt(0) || '?'}
          </span>
        ) : (
          <img
            ref={ref}
            src={src}
            alt={alt}
            className="w-full h-full object-cover"
            onError={() => setImageError(true)}
            {...props}
          />
        )}
      </div>
    )
  }
)

Avatar.displayName = 'Avatar'

// ============================================================================
// Convenience wrapper matching the raw inline markup used pre-v2
// (e.g. `(user.avatar_data as any)?.emoji`). Accepts the loosely-typed
// avatar_data straight from Supabase without callers needing to cast.
// ============================================================================

export interface UserAvatarProps extends HTMLAttributes<HTMLDivElement> {
  avatarData?: unknown
  size?: AvatarProps['size']
  alt?: string
}

export function UserAvatar({ avatarData, size = 'md', alt = 'Avatar', className = '', ...props }: UserAvatarProps) {
  const data = (avatarData || {}) as AvatarData
  return (
    <div
      className={`${sizeStyles[size ?? 'md']} rounded-full flex flex-col items-center justify-center shrink-0 ${className}`}
      style={{ backgroundColor: data.bgColor || '#1f9d90' }}
      role="img"
      aria-label={alt}
      {...props}
    >
      {data.accessory && (
        <span className="text-[0.6em] leading-none -mb-1" aria-hidden="true">
          {data.accessory}
        </span>
      )}
      <span>{data.emoji || '🙂'}</span>
    </div>
  )
}
