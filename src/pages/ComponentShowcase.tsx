import { useState } from 'react'
import {
  Button,
  Input,
  TextArea,
  Select,
  Card,
  Badge,
  Avatar,
  Modal,
  Toast,
  Spinner,
  EmptyState,
  Header,
  HeaderNavItem,
  BottomNav,
} from '../components'

/**
 * Component Showcase Page
 *
 * Demonstrates all UI components with various props and states.
 * Useful for development and as a living style guide.
 */
export function ComponentShowcase() {
  const [modalOpen, setModalOpen] = useState(false)
  const [showToast, setShowToast] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const [selectValue, setSelectValue] = useState('')

  return (
    <div className="min-h-screen bg-neutral-50">
      {/* Header */}
      <Header
        logo={
          <div className="flex items-center space-x-2">
            <div className="w-8 h-8 bg-primary-500 rounded-lg" />
            <span className="text-xl font-bold text-neutral-900">Trips</span>
          </div>
        }
        nav={
          <>
            <HeaderNavItem href="#" isActive>Home</HeaderNavItem>
            <HeaderNavItem href="#">Trips</HeaderNavItem>
            <HeaderNavItem href="#">Profile</HeaderNavItem>
          </>
        }
        actions={
          <Avatar
            src="https://api.dicebear.com/7.x/avataaars/svg?seed=Tim"
            alt="User"
            fallback="TK"
          />
        }
        sticky
      />

      {/* Main content */}
      <div className="container mx-auto px-4 py-8 pb-24 md:pb-8">
        <h1 className="text-4xl font-bold text-neutral-900 mb-2">Component Showcase</h1>
        <p className="text-neutral-600 mb-8">
          Demonstrating the Winter Clean design system with blue and orange accents.
        </p>

        {/* Buttons */}
        <Card className="mb-8">
          <Card.Header>
            <Card.Title>Buttons</Card.Title>
            <Card.Description>All button variants and sizes</Card.Description>
          </Card.Header>
          <Card.Content>
            <div className="space-y-4">
              {/* Variants */}
              <div>
                <h3 className="text-sm font-semibold text-neutral-700 mb-3">Variants</h3>
                <div className="flex flex-wrap gap-3">
                  <Button variant="primary">Primary</Button>
                  <Button variant="secondary">Secondary</Button>
                  <Button variant="outline">Outline</Button>
                  <Button variant="ghost">Ghost</Button>
                  <Button disabled>Disabled</Button>
                  <Button isLoading>Loading</Button>
                </div>
              </div>

              {/* Sizes */}
              <div>
                <h3 className="text-sm font-semibold text-neutral-700 mb-3">Sizes</h3>
                <div className="flex flex-wrap items-center gap-3">
                  <Button size="sm">Small</Button>
                  <Button size="md">Medium</Button>
                  <Button size="lg">Large</Button>
                </div>
              </div>
            </div>
          </Card.Content>
        </Card>

        {/* Form Inputs */}
        <Card className="mb-8">
          <Card.Header>
            <Card.Title>Form Inputs</Card.Title>
            <Card.Description>Text inputs, textareas, and selects</Card.Description>
          </Card.Header>
          <Card.Content>
            <div className="space-y-6">
              <Input
                label="Trip Name"
                placeholder="Enter trip name..."
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                helperText="Choose a memorable name for your trip"
                required
              />

              <Input
                label="Email"
                type="email"
                placeholder="your@email.com"
                error="Please enter a valid email address"
              />

              <Input
                label="Budget"
                type="number"
                placeholder="0"
                success
                helperText="Budget saved successfully"
              />

              <TextArea
                label="Trip Description"
                placeholder="Describe your trip..."
                rows={4}
                helperText="Tell your group about the trip plans"
              />

              <Select
                label="Trip Status"
                placeholder="Select status..."
                value={selectValue}
                onChange={(e) => setSelectValue(e.target.value)}
                options={[
                  { value: 'planning', label: 'Planning' },
                  { value: 'booking', label: 'Booking' },
                  { value: 'booked', label: 'Booked' },
                ]}
              />
            </div>
          </Card.Content>
        </Card>

        {/* Badges */}
        <Card className="mb-8">
          <Card.Header>
            <Card.Title>Badges</Card.Title>
            <Card.Description>Status indicators with different variants</Card.Description>
          </Card.Header>
          <Card.Content>
            <div className="flex flex-wrap gap-3">
              <Badge variant="primary">Primary</Badge>
              <Badge variant="secondary">Secondary</Badge>
              <Badge variant="success" dot>Success</Badge>
              <Badge variant="warning" dot>Warning</Badge>
              <Badge variant="error" dot>Error</Badge>
              <Badge variant="info">Info</Badge>
              <Badge variant="neutral">Neutral</Badge>
            </div>
          </Card.Content>
        </Card>

        {/* Avatars */}
        <Card className="mb-8">
          <Card.Header>
            <Card.Title>Avatars</Card.Title>
            <Card.Description>User avatars with different sizes and fallbacks</Card.Description>
          </Card.Header>
          <Card.Content>
            <div className="flex flex-wrap items-center gap-4">
              <Avatar size="xs" fallback="XS" />
              <Avatar size="sm" fallback="SM" />
              <Avatar size="md" fallback="MD" />
              <Avatar size="lg" fallback="LG" />
              <Avatar size="xl" fallback="XL" />
              <Avatar size="2xl" fallback="2XL" />
            </div>
          </Card.Content>
        </Card>

        {/* Feedback Components */}
        <Card className="mb-8">
          <Card.Header>
            <Card.Title>Feedback Components</Card.Title>
            <Card.Description>Modals, toasts, and loading states</Card.Description>
          </Card.Header>
          <Card.Content>
            <div className="space-y-6">
              {/* Modal trigger */}
              <div>
                <Button onClick={() => setModalOpen(true)}>Open Modal</Button>
              </div>

              {/* Toast trigger */}
              <div>
                <Button onClick={() => setShowToast(true)} variant="secondary">
                  Show Toast
                </Button>
              </div>

              {/* Spinners */}
              <div>
                <h3 className="text-sm font-semibold text-neutral-700 mb-3">Spinners</h3>
                <div className="flex items-center gap-4">
                  <Spinner size="sm" />
                  <Spinner size="md" />
                  <Spinner size="lg" />
                  <Spinner size="xl" variant="secondary" />
                </div>
              </div>
            </div>
          </Card.Content>
        </Card>

        {/* Empty State */}
        <Card className="mb-8">
          <Card.Header>
            <Card.Title>Empty State</Card.Title>
          </Card.Header>
          <Card.Content>
            <EmptyState
              icon={
                <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              }
              title="No trips yet"
              description="Create your first ski trip to start planning with your friends"
              action={<Button>Create Trip</Button>}
            />
          </Card.Content>
        </Card>
      </div>

      {/* Bottom Navigation (mobile only) */}
      <BottomNav>
        <BottomNav.Item
          icon={
            <svg fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
            </svg>
          }
          label="Home"
          isActive
        />
        <BottomNav.Item
          icon={
            <svg fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          }
          label="Add"
        />
        <BottomNav.Item
          icon={
            <svg fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
            </svg>
          }
          label="Profile"
          badge={3}
        />
      </BottomNav>

      {/* Modal */}
      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Example Modal"
        size="md"
      >
        <div className="space-y-4">
          <p className="text-neutral-600">
            This is a modal with proper accessibility features including focus trapping, escape key support, and backdrop clicks.
          </p>
          <div className="flex justify-end gap-3 pt-4">
            <Button variant="outline" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => setModalOpen(false)}>
              Confirm
            </Button>
          </div>
        </div>
      </Modal>

      {/* Toast */}
      {showToast && (
        <div className="fixed top-4 right-4 z-toast">
          <Toast
            type="success"
            message="Success!"
            description="Your action was completed successfully."
            onClose={() => setShowToast(false)}
            duration={5000}
          />
        </div>
      )}
    </div>
  )
}
