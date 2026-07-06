/**
 * Step-dots + labels stepper for the expense editor wizard and the quick
 * capture "refine later" flow (Form & Flow Standard, UPGRADE_MASTER_PLAN §5
 * point 3: "all multi-step flows render the shared Stepper").
 *
 * TEMPORARY LOCAL COMPONENT: the plan calls for a shared
 * `src/components/ui/Stepper` (owned by the design-system workstream), not
 * yet present in the tree when this feature was built. This is a
 * self-contained equivalent using the same design tokens so it looks
 * identical to what will land; swap the import for the shared one when
 * available (props are kept intentionally simple/compatible).
 */

export interface StepperStep {
  key: string
  label: string
}

export interface StepperProps {
  steps: StepperStep[]
  currentIndex: number
  /** Tapping an earlier (already-visited) step's dot/label jumps back, preserving data (plan requirement: "tappable back preserving data"). */
  onStepClick?: (index: number) => void
  className?: string
}

export function Stepper({ steps, currentIndex, onStepClick, className = '' }: StepperProps) {
  return (
    <div className={`flex items-center gap-1.5 ${className}`.trim()} role="tablist" aria-label="Progress">
      {steps.map((step, i) => {
        const isActive = i === currentIndex
        const isComplete = i < currentIndex
        const isClickable = isComplete && !!onStepClick

        return (
          <div key={step.key} className="flex items-center flex-1 last:flex-none">
            <button
              type="button"
              disabled={!isClickable}
              onClick={() => isClickable && onStepClick?.(i)}
              role="tab"
              aria-selected={isActive}
              aria-label={step.label}
              className={`
                flex items-center gap-1.5 shrink-0 rounded-[var(--radius-full)] transition-colors duration-150
                ${isClickable ? 'cursor-pointer' : 'cursor-default'}
              `.trim()}
            >
              <span
                className={`
                  flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold shrink-0
                  transition-colors duration-150
                  ${isActive ? 'bg-accent-600 text-white' : isComplete ? 'bg-accent-100 text-accent-700 dark:bg-accent-900 dark:text-accent-300' : 'bg-[var(--surface-sunken)] text-[var(--text-muted)]'}
                `.trim()}
              >
                {isComplete ? (
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>
              <span
                className={`hidden sm:inline text-xs font-medium whitespace-nowrap ${
                  isActive ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
                }`}
              >
                {step.label}
              </span>
            </button>

            {i < steps.length - 1 && (
              <span
                aria-hidden="true"
                className={`flex-1 h-0.5 mx-1.5 rounded-full ${isComplete ? 'bg-accent-300 dark:bg-accent-700' : 'bg-[var(--border-subtle)]'}`}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
