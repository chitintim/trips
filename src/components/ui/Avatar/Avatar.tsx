import { ImgHTMLAttributes, forwardRef, useState } from 'react'

// ============================================================================
// TYPES
// ============================================================================

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

export const Avatar = forwardRef<HTMLImageElement, AvatarProps>(
  (
    {
      src,
      fallback,
      alt = 'Avatar',
      size = 'md',
      shape = 'circle',
      className = '',
      ...props
    },
    ref
  ) => {
    const [imageError, setImageError] = useState(false)

    // Show fallback if no src, image failed, or fallback is explicitly provided without src
    const showFallback = !src || imageError || (fallback && !src)

    // Base styles
    const baseStyles = `
      inline-flex
      items-center
      justify-center
      overflow-hidden
      bg-gradient-to-br from-primary-400 to-primary-600
      text-white
      font-semibold
      select-none
    `

    // Size styles
    const sizeStyles = {
      xs: 'w-6 h-6 text-xs',
      sm: 'w-8 h-8 text-sm',
      md: 'w-10 h-10 text-base',
      lg: 'w-12 h-12 text-lg',
      xl: 'w-16 h-16 text-xl',
      '2xl': 'w-20 h-20 text-2xl',
    }

    // Shape styles
    const shapeStyles = {
      circle: 'rounded-full',
      square: 'rounded-lg',
    }

    // Combine all styles
    const avatarClasses = `
      ${baseStyles}
      ${sizeStyles[size]}
      ${shapeStyles[shape]}
      ${className}
    `.trim().replace(/\s+/g, ' ')

    const handleImageError = () => {
      setImageError(true)
    }

    return (
      <div className={avatarClasses}>
        {showFallback ? (
          // Fallback content (initials or icon)
          <span className="uppercase">
            {fallback || alt.charAt(0) || '?'}
          </span>
        ) : (
          // Image
          <img
            ref={ref}
            src={src}
            alt={alt}
            className="w-full h-full object-cover"
            onError={handleImageError}
            {...props}
          />
        )}
      </div>
    )
  }
)

Avatar.displayName = 'Avatar'
