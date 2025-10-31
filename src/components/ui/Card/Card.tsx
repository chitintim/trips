import { HTMLAttributes, forwardRef } from 'react'

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
      className = '',
      children,
      ...props
    },
    ref
  ) => {
    const baseStyles = `
      bg-white
      rounded-lg
      border border-neutral-200
      shadow-sm
      transition-all duration-200
    `

    const interactionStyles = `
      ${hoverable ? 'hover:shadow-md hover:-translate-y-0.5' : ''}
      ${clickable ? 'cursor-pointer' : ''}
    `

    const paddingStyles = noPadding ? '' : 'p-6'

    const cardClasses = `
      ${baseStyles}
      ${interactionStyles}
      ${paddingStyles}
      ${className}
    `.trim().replace(/\s+/g, ' ')

    return (
      <div ref={ref} className={cardClasses} {...props}>
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
        className={`text-xl font-semibold text-neutral-900 leading-tight ${className}`}
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
        className={`text-sm text-neutral-500 ${className}`}
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
