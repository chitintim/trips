/**
 * Component Library - Central Exports
 *
 * Import all components from this single file:
 * import { Button, Input, Card, Badge } from '@/components'
 */

// ============================================================================
// UI COMPONENTS
// ============================================================================

// Form components
export { Button } from './ui/Button'
export type { ButtonProps } from './ui/Button'

export { Input } from './ui/Input'
export type { InputProps } from './ui/Input'

export { TextArea } from './ui/TextArea'
export type { TextAreaProps } from './ui/TextArea'

export { Select } from './ui/Select'
export type { SelectProps, SelectOption } from './ui/Select'

// Layout components
export { Card } from './ui/Card'
export type {
  CardProps,
  CardHeaderProps,
  CardTitleProps,
  CardDescriptionProps,
  CardContentProps,
  CardFooterProps,
} from './ui/Card'

export { Badge } from './ui/Badge'
export type { BadgeProps } from './ui/Badge'

export { Avatar } from './ui/Avatar'
export type { AvatarProps } from './ui/Avatar'

// Feedback components
export { Modal } from './ui/Modal'
export type { ModalProps } from './ui/Modal'

export { Toast } from './ui/Toast'
export type { ToastProps } from './ui/Toast'

export { Spinner } from './ui/Spinner'
export type { SpinnerProps } from './ui/Spinner'

export { EmptyState } from './ui/EmptyState'
export type { EmptyStateProps } from './ui/EmptyState'

// ============================================================================
// LAYOUT COMPONENTS
// ============================================================================

export { Header, HeaderNavItem } from './layout/Header'
export type { HeaderProps, HeaderNavItemProps } from './layout/Header'

export { BottomNav } from './layout/BottomNav'
export type { BottomNavProps, BottomNavItemProps } from './layout/BottomNav'

// ============================================================================
// FEATURE COMPONENTS
// ============================================================================

export { CreateTripModal } from './CreateTripModal'
export { CreateInvitationModal } from './CreateInvitationModal'
export { ProfileModal } from './ProfileModal'
export { AddParticipantModal } from './AddParticipantModal'
export { ViewUserTripsModal } from './ViewUserTripsModal'
