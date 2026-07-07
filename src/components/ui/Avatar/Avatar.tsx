import { HTMLAttributes, ImgHTMLAttributes, forwardRef, useState } from 'react'
import type { AvatarData } from '../../../types'
import { resolveAvatar } from './resolveAvatar'
import { ICON_REGISTRY } from './icons/travelIcons'

// ============================================================================
// TYPES
// ============================================================================

export type { AvatarData }

export interface AvatarProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  /**
   * Image source URL. Takes priority over `avatarUrl` when both are given
   * (this is the generic "any image" prop; `avatarUrl` is the avatar-system
   * specific one -- see `resolveAvatar`'s resolution order).
   */
  src?: string

  /**
   * Fallback text (usually initials) if image fails to load
   */
  fallback?: string

  /**
   * users.avatar_url (avatar system v2 "upload" type) -- highest-priority
   * resolved avatar source after `src`. Prefer this over `src` for
   * user-avatar call sites; `src` remains for non-user images.
   */
  avatarUrl?: string | null

  /**
   * Resolvable avatar_data: either the v2 icon shape
   * (`{type:'icon', icon, bgColor}`) or the legacy emoji shape
   * (`{emoji, accessory, bgColor}`). Also accepts the raw user row shape
   * (`{avatar_url, avatar_data}`) for callers that have the whole user
   * object handy -- see `resolveAvatar`.
   */
  avatarData?: AvatarData | Partial<AvatarData> | unknown | null

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
      avatarUrl,
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

    // Resolver order (UX_REDESIGN.md "Avatar system v2"): avatar_url ->
    // icon -> legacy emoji -> initials. `src` (generic image prop) wins
    // over the resolved avatar_url only when both are explicitly given.
    const resolved = resolveAvatar({ avatarUrl: src ? undefined : avatarUrl, avatarData })

    if (!src && resolved.kind === 'photo') {
      return (
        <div className={`${combinedClasses} bg-gradient-to-br from-accent-400 to-accent-600`}>
          {imageError ? (
            <span className="uppercase">{fallback || alt.charAt(0) || '?'}</span>
          ) : (
            <img
              ref={ref}
              src={resolved.url}
              alt={alt}
              className="w-full h-full object-cover"
              onError={() => setImageError(true)}
              {...props}
            />
          )}
        </div>
      )
    }

    if (!src && resolved.kind === 'icon') {
      const Icon = ICON_REGISTRY[resolved.icon]
      return (
        <div
          className={`${combinedClasses} bg-accent-500`}
          style={{ backgroundColor: resolved.bgColor }}
          role="img"
          aria-label={alt}
        >
          <Icon className="w-[60%] h-[60%] text-white" />
        </div>
      )
    }

    if (!src && resolved.kind === 'emoji') {
      return (
        <div
          className={`${combinedClasses} flex-col bg-accent-500`}
          style={{ backgroundColor: resolved.bgColor }}
          role="img"
          aria-label={alt}
        >
          {resolved.accessory && (
            <span className="text-[0.6em] leading-none -mb-1" aria-hidden="true">
              {resolved.accessory}
            </span>
          )}
          <span>{resolved.emoji}</span>
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
// avatar_data straight from Supabase without callers needing to cast --
// AND (avatar system v2) the raw user row shape `{avatar_url, avatar_data}`
// so callers can pass the whole user object and get upload/icon/emoji/
// initials resolution for free. See `resolveAvatar` for the precise rules.
// ============================================================================

export interface UserAvatarProps extends HTMLAttributes<HTMLDivElement> {
  avatarData?: unknown
  size?: AvatarProps['size']
  alt?: string
}

export function UserAvatar({ avatarData, size = 'md', alt = 'Avatar', className = '', ...props }: UserAvatarProps) {
  const resolved = resolveAvatar({ avatarData })
  const sizeAndShape = `${sizeStyles[size ?? 'md']} rounded-full flex shrink-0 ${className}`

  if (resolved.kind === 'photo') {
    return (
      <div className={`${sizeAndShape} items-center justify-center overflow-hidden bg-gradient-to-br from-accent-400 to-accent-600`} {...props}>
        <img src={resolved.url} alt={alt} className="w-full h-full object-cover" />
      </div>
    )
  }

  if (resolved.kind === 'icon') {
    const Icon = ICON_REGISTRY[resolved.icon]
    return (
      <div
        className={`${sizeAndShape} items-center justify-center`}
        style={{ backgroundColor: resolved.bgColor }}
        role="img"
        aria-label={alt}
        {...props}
      >
        <Icon className="w-[60%] h-[60%] text-white" />
      </div>
    )
  }

  const bgColor = resolved.kind === 'emoji' ? resolved.bgColor : '#1f9d90'
  const emoji = resolved.kind === 'emoji' ? resolved.emoji : '🙂'
  const accessory = resolved.kind === 'emoji' ? resolved.accessory : null

  return (
    <div
      className={`${sizeAndShape} flex-col items-center justify-center`}
      style={{ backgroundColor: bgColor }}
      role="img"
      aria-label={alt}
      {...props}
    >
      {accessory && (
        <span className="text-[0.6em] leading-none -mb-1" aria-hidden="true">
          {accessory}
        </span>
      )}
      <span>{emoji}</span>
    </div>
  )
}
