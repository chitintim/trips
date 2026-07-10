import { HTMLAttributes } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface StepperStep {
  key: string
  label: string
}

export interface StepperProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onClick'> {
  steps: StepperStep[]
  /** Current step, matched against `step.key` or the step's index. */
  current: string | number
  /** Called with the step's index when a completed (or current) step is clicked. Omit to make the stepper non-interactive. */
  onStepClick?: (index: number) => void
  size?: 'sm' | 'md'
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * Horizontal step-dots + labels for multi-step flows (Form & Flow Standard,
 * UPGRADE_MASTER_PLAN.md §5.3). Completed steps are accent-filled and
 * tappable when `onStepClick` is given (so users can go back without losing
 * data); the current step is emphasized; upcoming steps are muted.
 *
 * Mobile-first: labels collapse to "current step only" below `sm:` so the
 * rail stays compact on narrow phones, and expand to all labels at `sm:` and
 * up.
 */
export function Stepper({
  steps,
  current,
  onStepClick,
  size = 'md',
  className = '',
  ...props
}: StepperProps) {
  const currentIndex =
    typeof current === 'number' ? current : steps.findIndex((s) => s.key === current)

  const dotSize = size === 'sm' ? 'w-6 h-6 text-[0.6875rem]' : 'w-8 h-8 text-xs'
  const labelSize = size === 'sm' ? 'text-[0.6875rem]' : 'text-xs'

  return (
    <div
      role="group"
      aria-label="Progress"
      className={`flex items-start w-full ${className}`.trim()}
      {...props}
    >
      {steps.map((step, index) => {
        const isCompleted = index < currentIndex
        const isCurrent = index === currentIndex
        const isUpcoming = index > currentIndex
        const isTappable = !!onStepClick && (isCompleted || isCurrent)
        const isLast = index === steps.length - 1

        const dotClasses = `
          flex items-center justify-center shrink-0 rounded-full font-semibold
          transition-colors duration-150
          ${dotSize}
          ${isCompleted ? 'bg-accent-600 text-white' : ''}
          ${isCurrent ? 'bg-accent-600 text-white ring-2 ring-offset-2 ring-offset-[var(--surface-raised)] ring-accent-300' : ''}
          ${isUpcoming ? 'bg-[var(--surface-sunken)] text-[var(--text-muted)]' : ''}
        `.trim().replace(/\s+/g, ' ')

        const StepButtonOrDiv = isTappable ? 'button' : 'div'

        return (
          // min-w-0 overrides the flex item's default `min-width: auto`,
          // which otherwise floors shrinking at the dot+label's content
          // size (the classic flexbox-overflow footgun) — without it, a
          // step whose current label is wide enough (or whose font is
          // scaled up by OS text-size settings) can't compress and can
          // push the row past the container width on narrow phones.
          <div key={step.key} className={`flex items-center min-w-0 ${isLast ? '' : 'flex-1'}`}>
            <div className="flex flex-col items-center gap-1.5">
              <StepButtonOrDiv
                type={isTappable ? 'button' : undefined}
                onClick={isTappable ? () => onStepClick(index) : undefined}
                disabled={StepButtonOrDiv === 'button' ? !isTappable : undefined}
                aria-current={isCurrent ? 'step' : undefined}
                aria-label={`${step.label}${isCompleted ? ' (completed)' : isCurrent ? ' (current)' : ''}`}
                className={`${dotClasses} ${isTappable ? 'cursor-pointer hover:brightness-110 active:brightness-95' : 'cursor-default'}`}
              >
                {isCompleted ? (
                  <svg
                    className="w-3.5 h-3.5"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={3}
                    stroke="currentColor"
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                ) : (
                  index + 1
                )}
              </StepButtonOrDiv>

              <span
                className={`
                  ${labelSize} font-medium text-center whitespace-nowrap
                  ${isCurrent ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}
                  ${isCurrent ? 'block' : 'hidden sm:block'}
                `.trim().replace(/\s+/g, ' ')}
              >
                {step.label}
              </span>
            </div>

            {!isLast && (
              <div
                aria-hidden="true"
                className={`
                  flex-1 h-0.5 mx-1.5 rounded-full -translate-y-3.5
                  ${index < currentIndex ? 'bg-accent-600' : 'bg-[var(--border-subtle)]'}
                `.trim().replace(/\s+/g, ' ')}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

Stepper.displayName = 'Stepper'
