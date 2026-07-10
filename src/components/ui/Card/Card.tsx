import { HTMLAttributes, KeyboardEvent, MouseEvent, forwardRef } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Add hover effect (slight lift and shadow)
   */
  hoverable?: boolean

  /**
   * Add click effect (cursor pointer)
   */
  clickable?: boolean

  /**
   * Remove padding from card body
   */
  noPadding?: boolean

  /**
   * Visual weight of the card surface
   * - default: raised surface with border + soft shadow
   * - flat: raised surface, no shadow (for nested cards)
   * - sunken: recessed surface (for list rows / secondary content)
   */
  variant?: 'default' | 'flat' | 'sunken'
}

export interface CardHeaderProps extends HTMLAttributes<HTMLDivElement> {}
export interface CardTitleProps extends HTMLAttributes<HTMLHeadingElement> {}
export interface CardDescriptionProps extends HTMLAttributes<HTMLParagraphElement> {}
export interface CardContentProps extends HTMLAttributes<HTMLDivElement> {}
export interface CardFooterProps extends HTMLAttributes<HTMLDivElement> {}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

const CardRoot = forwardRef<HTMLDivElement, CardProps>(
  (
    {
      hoverable = false,
      clickable = false,
      noPadding = false,
      variant = 'default',
      className = '',
      children,
      onClick,
      onKeyDown,
      role,
      tabIndex,
      ...props
    },
    ref
  ) => {
    const variantStyles = {
      default: 'bg-[var(--surface-raised)] border border-[var(--border-subtle)] shadow-sm',
      flat: 'bg-[var(--surface-raised)] border border-[var(--border-subtle)]',
      sunken: 'bg-[var(--surface-sunken)] border border-transparent',
    }

    const baseStyles = `
      rounded-[var(--radius-lg)]
      transition-shadow duration-200
      ${variantStyles[variant]}
    `

    const interactionStyles = `
      ${hoverable ? 'hover:shadow-md hover:-translate-y-0.5' : ''}
      ${clickable ? 'cursor-pointer press-scale' : ''}
    `

    const paddingStyles = noPadding ? '' : 'p-5 sm:p-6'

    const cardClasses = `
      ${baseStyles}
      ${interactionStyles}
      ${paddingStyles}
      ${className}
    `.trim().replace(/\s+/g, ' ')

    // Only a card that is both visually "clickable" AND actually wired up
    // with a click handler gets interactive a11y semantics -- a merely
    // hoverable card, or a clickable-but-handlerless one, stays a plain
    // <div> (never adds a role/tabIndex a screen reader or keyboard user
    // can't act on).
    const isInteractive = clickable && !!onClick

    const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(e)
      if (!isInteractive || e.defaultPrevented) return
      // Only activate on a key event that originated on the card itself --
      // if it bubbled up from a nested real <button>/<a>/input, that
      // element already handles its own activation and firing here too
      // would double-fire the card's onClick.
      if (e.target !== e.currentTarget) return
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault()
        onClick?.(e as unknown as MouseEvent<HTMLDivElement>)
      }
    }

    return (
      <div
        ref={ref}
        className={cardClasses}
        onClick={onClick}
        role={isInteractive ? role ?? 'button' : role}
        tabIndex={isInteractive ? tabIndex ?? 0 : tabIndex}
        onKeyDown={isInteractive ? handleKeyDown : onKeyDown}
        {...props}
      >
        {children}
      </div>
    )
  }
)

CardRoot.displayName = 'Card'

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

const CardHeader = forwardRef<HTMLDivElement, CardHeaderProps>(
  ({ className = '', children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={`flex flex-col space-y-1.5 ${className}`}
        {...props}
      >
        {children}
      </div>
    )
  }
)

CardHeader.displayName = 'Card.Header'

const CardTitle = forwardRef<HTMLHeadingElement, CardTitleProps>(
  ({ className = '', children, ...props }, ref) => {
    return (
      <h3
        ref={ref}
        className={`text-lg font-semibold text-[var(--text-primary)] leading-tight ${className}`}
        {...props}
      >
        {children}
      </h3>
    )
  }
)

CardTitle.displayName = 'Card.Title'

const CardDescription = forwardRef<HTMLParagraphElement, CardDescriptionProps>(
  ({ className = '', children, ...props }, ref) => {
    return (
      <p
        ref={ref}
        className={`text-sm text-[var(--text-secondary)] ${className}`}
        {...props}
      >
        {children}
      </p>
    )
  }
)

CardDescription.displayName = 'Card.Description'

const CardContent = forwardRef<HTMLDivElement, CardContentProps>(
  ({ className = '', children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={`pt-6 ${className}`}
        {...props}
      >
        {children}
      </div>
    )
  }
)

CardContent.displayName = 'Card.Content'

const CardFooter = forwardRef<HTMLDivElement, CardFooterProps>(
  ({ className = '', children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={`flex items-center pt-6 ${className}`}
        {...props}
      >
        {children}
      </div>
    )
  }
)

CardFooter.displayName = 'Card.Footer'

// ============================================================================
// EXPORTS
// ============================================================================

export const Card = Object.assign(CardRoot, {
  Header: CardHeader,
  Title: CardTitle,
  Description: CardDescription,
  Content: CardContent,
  Footer: CardFooter,
})
