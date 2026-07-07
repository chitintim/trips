// Form Components
export { Button } from './Button'
export { Input } from './Input'
export { TextArea } from './TextArea'
export { Select } from './Select'

// Layout Components
export { Card } from './Card'
export { Badge } from './Badge'
export { Avatar, UserAvatar } from './Avatar'

// Feedback Components
export { Modal } from './Modal'
export { Toast, ToastProvider, useToast } from './Toast'
export type { ToastOptions } from './Toast'
export { Spinner } from './Spinner'
export { EmptyState } from './EmptyState'
export { Skeleton } from './Skeleton'

// Navigation / selection
export { Tabs } from './Tabs'
export { SegmentedControl } from './SegmentedControl'
export { Chip } from './Chip'

// Data display
export { ProgressBar } from './ProgressBar'
export { StatCard } from './StatCard'

// Social Components
export { SelectionAvatars } from './SelectionAvatars'

// Confirmation System Components
export { ConfirmationStatusBadge } from './ConfirmationStatusBadge'
export { CapacityProgressBar } from './CapacityProgressBar'
export { ConditionalDependencyDisplay } from './ConditionalDependencyDisplay'

// Deadline / countdown chip (added by workstream C — reused across
// confirmations, decisions/polls, bookings, waitlist offers)
export { Deadline, getDeadlineUrgency, formatDeadlineLabel } from './Deadline'
export type { DeadlineProps } from './Deadline'

// Form & Flow Standard components (UPGRADE_MASTER_PLAN.md §5)
export { Stepper } from './Stepper'
export type { StepperProps, StepperStep } from './Stepper'
export { ConfirmDiscardSheet } from './ConfirmDiscardSheet'
export type { ConfirmDiscardSheetProps } from './ConfirmDiscardSheet'

// Illustration identity (UX_REDESIGN.md Part 4 "Illustrations")
export {
  ILLUSTRATION_REGISTRY,
  EmptyPlan,
  NoExpenses,
  AllSettled,
  RetroHeader,
  JoinCover,
  NothingToDecide,
  Offline,
  ErrorState,
} from './illustrations'
export type { IllustrationName } from './illustrations'
