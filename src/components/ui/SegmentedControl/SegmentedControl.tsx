import { HTMLAttributes } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface SegmentedControlOption<T extends string = string> {
  value: T
  label: string
  icon?: React.ReactNode
  disabled?: boolean
}

export interface SegmentedControlProps<T extends string = string>
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  options: SegmentedControlOption<T>[]
  value: T
  onChange: (value: T) => void
  size?: 'sm' | 'md'
  fullWidth?: boolean
}

// ============================================================================
// COMPONENT
// ============================================================================

export function SegmentedControl<T extends string = string>({
  options,
  value,
  onChange,
  size = 'md',
  fullWidth = false,
  className = '',
  ...props
}: SegmentedControlProps<T>) {
  const sizeStyles = {
    sm: 'h-8 text-xs px-2.5',
    md: 'h-9 text-sm px-3.5',
  }

  return (
    <div
      role="tablist"
      className={`
        inline-flex items-center gap-0.5 p-1 rounded-[var(--radius-md)]
        bg-[var(--surface-sunken)]
        ${fullWidth ? 'w-full' : ''}
        ${className}
      `.trim().replace(/\s+/g, ' ')}
      {...props}
    >
      {options.map((option) => {
        const isActive = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={`
              inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-sm)] font-medium
              transition-all duration-150
              disabled:opacity-40 disabled:cursor-not-allowed
              ${fullWidth ? 'flex-1' : ''}
              ${sizeStyles[size]}
              ${isActive
                ? 'bg-[var(--surface-raised)] text-[var(--text-primary)] shadow-sm'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }
            `.trim().replace(/\s+/g, ' ')}
          >
            {option.icon && <span aria-hidden="true">{option.icon}</span>}
            <span className="whitespace-nowrap">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}

SegmentedControl.displayName = 'SegmentedControl'
