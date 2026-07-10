import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../hooks/useAuth'
import { useScrollDirection } from '../hooks/useScrollDirection'
import { supabase } from '../lib/supabase'
import {
  Badge,
  Button,
  Card,
  ConfirmDiscardSheet,
  EmptyState,
  Input,
  Modal,
  Select,
  Skeleton,
  StatCard,
  Tabs,
  UserAvatar,
  useToast,
} from '../components/ui'
import { ProfileModal } from '../components/ProfileModal'
import { ViewUserTripsModal } from '../components/ViewUserTripsModal'
import { MemberDashboard, CreateTripWizard } from '../features/dashboard'
import { useTrips, useCurrentUserRow, type TripWithCount } from '../lib/queries/useTrip'
import { useInvitations, useCreateInvitation, useDeleteInvitation } from '../lib/queries/useInvitations'
import { queryKeys } from '../lib/queries/queryKeys'
import { useFormDraft, useUnsavedChangesGuard } from '../lib/forms'
import { User, Trip, Invitation } from '../types'
import { getTripStatusBadgeVariant, getTripStatusLabel, getTripTiming, isConfirmationEnabled } from '../lib/tripStatus'

type AdminTab = 'trips' | 'users' | 'invitations'

/**
 * Dashboard page (workstream G rebuild): non-admins get the new
 * MemberDashboard (src/features/dashboard); admins get the Users /
 * Invitations / Trips console rebuilt on the v2 design system. Data layer
 * unchanged — same tables/RPCs as the legacy page (users select,
 * create_invitation RPC, trips + confirmed counts via useTrips).
 */
export function Dashboard() {
  const { user, signOut } = useAuth()
  const queryClient = useQueryClient()
  const scrollDirection = useScrollDirection()
  const { showToast } = useToast()
  const [activeTab, setActiveTab] = useState<AdminTab>('trips')
  const [signingOut, setSigningOut] = useState(false)
  const [profileModalOpen, setProfileModalOpen] = useState(false)
  const [signOutConfirmOpen, setSignOutConfirmOpen] = useState(false)

  const { data: currentUser, isLoading } = useCurrentUserRow(user?.id)
  const isAdmin = currentUser?.role === 'admin'

  const handleSignOut = async () => {
    setSignOutConfirmOpen(false)
    try {
      setSigningOut(true)
      const { error } = await signOut()
      if (error) {
        showToast({ type: 'error', message: 'Sign out failed', description: error.message })
        setSigningOut(false)
        return
      }
      // Full reload clears state; window.location works best on mobile Safari.
      window.location.href = window.location.origin + '/trips/login'
    } catch (err) {
      showToast({ type: 'error', message: 'Unexpected error', description: (err as Error)?.message || 'Please try again' })
      setSigningOut(false)
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[var(--surface-page)] p-4">
        <div className="mx-auto max-w-7xl space-y-4 pt-8">
          <Skeleton variant="card" height={56} />
          <Skeleton variant="card" height={160} />
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[var(--surface-page)]">
      {/* Header */}
      <header
        className={`sticky top-0 z-sticky border-b border-[var(--border-subtle)] bg-[var(--surface-raised)] shadow-sm transition-transform duration-300 ease-in-out ${
          scrollDirection === 'down' ? '-translate-y-full' : 'translate-y-0'
        }`}
      >
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-md)] bg-accent-600 font-semibold text-white">
                T
              </span>
              <div>
                <h1 className="text-xl font-bold text-[var(--text-primary)]">Trips</h1>
                {isAdmin && <span className="text-xs font-medium text-accent-600 dark:text-accent-400">Admin</span>}
              </div>
            </div>
            <div className="flex items-center gap-3">
              {currentUser && (
                <button
                  onClick={() => setProfileModalOpen(true)}
                  className="flex items-center gap-2 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                >
                  <UserAvatar avatarData={currentUser} size="sm" />
                  <span className="hidden sm:inline">{currentUser.full_name || user?.email}</span>
                </button>
              )}
              <Button variant="secondary" size="sm" onClick={() => setSignOutConfirmOpen(true)} isLoading={signingOut}>
                Sign out
              </Button>
            </div>
          </div>
        </div>

        {isAdmin && (
          <div className="border-t border-[var(--border-subtle)]">
            <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
              <Tabs value={activeTab} onChange={(v) => setActiveTab(v as AdminTab)}>
                <Tabs.List>
                  <Tabs.Tab value="trips">🏔️ Trips</Tabs.Tab>
                  <Tabs.Tab value="users">👥 Users</Tabs.Tab>
                  <Tabs.Tab value="invitations">🎫 Invitations</Tabs.Tab>
                </Tabs.List>
              </Tabs>
            </div>
          </div>
        )}
      </header>

      {/* Main */}
      <main className={isAdmin ? 'mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8' : 'py-4'}>
        {isAdmin ? (
          <>
            {activeTab === 'trips' && <AdminTripsTab />}
            {activeTab === 'users' && <AdminUsersTab />}
            {activeTab === 'invitations' && <AdminInvitationsTab />}
          </>
        ) : (
          <MemberDashboard />
        )}
      </main>

      {currentUser && (
        <ProfileModal
          isOpen={profileModalOpen}
          onClose={() => setProfileModalOpen(false)}
          user={currentUser}
          onUpdate={() => queryClient.invalidateQueries({ queryKey: queryKeys.currentUser(user?.id) })}
        />
      )}

      <Modal isOpen={signOutConfirmOpen} onClose={() => setSignOutConfirmOpen(false)} size="sm" title="Sign out?">
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">You'll need to sign in again to get back to your trips.</p>
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setSignOutConfirmOpen(false)} disabled={signingOut}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleSignOut} isLoading={signingOut}>
              Sign out
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared: date-bucketed trip ordering (ongoing → upcoming → past), matching
// the legacy Dashboard's sort exactly.
// ---------------------------------------------------------------------------

function bucketAndSortTrips<T extends Trip>(trips: T[]): { ongoing: T[]; upcoming: T[]; past: T[]; ordered: T[] } {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const ongoing = trips
    .filter((t) => new Date(t.start_date) <= today && new Date(t.end_date) >= today)
    .sort((a, b) => new Date(a.end_date).getTime() - new Date(b.end_date).getTime())
  const upcoming = trips
    .filter((t) => new Date(t.start_date) > today)
    .sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())
  const past = trips
    .filter((t) => new Date(t.end_date) < today)
    .sort((a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime())
  return { ongoing, upcoming, past, ordered: [...ongoing, ...upcoming, ...past] }
}

function formatDate(date: string): string {
  return new Date(date).toLocaleDateString('en-GB')
}

// ---------------------------------------------------------------------------
// Trips tab (admin)
// ---------------------------------------------------------------------------

function AdminTripsTab() {
  const navigate = useNavigate()
  const { data: trips, isLoading } = useTrips()
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [editingTrip, setEditingTrip] = useState<Trip | null>(null)
  const queryClient = useQueryClient()

  const buckets = useMemo(() => bucketAndSortTrips<TripWithCount>(trips ?? []), [trips])

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton variant="card" height={80} />
        <Skeleton variant="card" height={160} />
      </div>
    )
  }

  const openCreate = () => {
    setEditingTrip(null)
    setCreateModalOpen(true)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-[var(--text-primary)]">Trips</h2>
          <p className="text-sm text-[var(--text-secondary)]">Every trip on the platform</p>
        </div>
        <Button onClick={openCreate}>+ Create trip</Button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Ongoing" value={String(buckets.ongoing.length)} icon={<span>🎿</span>} size="sm" />
        <StatCard label="Upcoming" value={String(buckets.upcoming.length)} icon={<span>📅</span>} size="sm" />
        <StatCard label="Past" value={String(buckets.past.length)} icon={<span>🏁</span>} size="sm" />
      </div>

      {buckets.ordered.length === 0 ? (
        <Card>
          <Card.Content className="py-12">
            <EmptyState
              icon="🏔️"
              title="No trips yet"
              description="Create the first trip to start organizing an adventure."
              action={<Button onClick={openCreate}>Create your first trip</Button>}
            />
          </Card.Content>
        </Card>
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-[var(--border-subtle)] bg-[var(--surface-sunken)]">
                <tr>
                  {['Trip', 'Stage', 'Dates', 'Confirmed', ''].map((h, i) => (
                    <th
                      key={i}
                      className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {buckets.ordered.map((trip) => {
                  const timing = getTripTiming(trip.start_date, trip.end_date)
                  return (
                    <tr
                      key={trip.id}
                      className="cursor-pointer transition-colors hover:bg-[var(--surface-sunken)]"
                      onClick={() => navigate(`/${trip.id}`)}
                    >
                      <td className="px-4 py-3">
                        <p className="font-medium text-[var(--text-primary)]">{trip.name}</p>
                        <p className="text-xs text-[var(--text-muted)]">📍 {trip.location}</p>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          <Badge variant={getTripStatusBadgeVariant(trip.status)} size="sm">
                            {getTripStatusLabel(trip.status)}
                          </Badge>
                          {timing && (
                            <Badge variant={timing.variant} size="sm">
                              {timing.label}
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-[var(--text-secondary)]">
                        {formatDate(trip.start_date)} – {formatDate(trip.end_date)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-[var(--text-secondary)]">
                        {isConfirmationEnabled(trip)
                          ? `👥 ${trip.capacity_limit ? `${trip.confirmed_count}/${trip.capacity_limit}` : trip.confirmed_count}`
                          : '—'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditingTrip(trip)
                            setCreateModalOpen(true)
                          }}
                        >
                          Edit
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <CreateTripWizard
        isOpen={createModalOpen}
        onClose={() => {
          setCreateModalOpen(false)
          setEditingTrip(null)
        }}
        onSuccess={() => queryClient.invalidateQueries({ queryKey: queryKeys.trips() })}
        editTrip={editingTrip}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Users tab (admin)
// ---------------------------------------------------------------------------

function AdminUsersTab() {
  const { data: users, isLoading } = useQuery({
    queryKey: ['adminUsers'] as const,
    queryFn: async (): Promise<User[]> => {
      const { data, error } = await supabase.from('users').select('*').order('created_at', { ascending: false })
      if (error) throw error
      return data || []
    },
  })

  // Trips-per-user badge: one lightweight membership query, counted client-side.
  const { data: tripCounts } = useQuery({
    queryKey: ['adminUserTripCounts'] as const,
    queryFn: async (): Promise<Map<string, number>> => {
      const { data, error } = await supabase.from('trip_participants').select('user_id')
      if (error) throw error
      const counts = new Map<string, number>()
      for (const row of data || []) counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1)
      return counts
    },
  })

  const [selectedUser, setSelectedUser] = useState<User | null>(null)

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton variant="card" height={80} />
        <Skeleton variant="list" lines={5} />
      </div>
    )
  }

  const admins = (users ?? []).filter((u) => u.role === 'admin')

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-[var(--text-primary)]">Users</h2>
        <p className="text-sm text-[var(--text-secondary)]">Everyone with an account, and their trips</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Users" value={String(users?.length ?? 0)} icon={<span>👥</span>} size="sm" />
        <StatCard label="Admins" value={String(admins.length)} icon={<span>🛡️</span>} size="sm" />
      </div>

      {(users ?? []).length === 0 ? (
        <Card>
          <Card.Content className="py-12">
            <EmptyState icon="👥" title="No users yet" description="New signups will appear here." />
          </Card.Content>
        </Card>
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-[var(--border-subtle)] bg-[var(--surface-sunken)]">
                <tr>
                  {['User', 'Role', 'Trips', 'Joined', ''].map((h, i) => (
                    <th
                      key={i}
                      className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {(users ?? []).map((u) => (
                  <tr key={u.id} className="transition-colors hover:bg-[var(--surface-sunken)]">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <UserAvatar avatarData={u} size="sm" />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-[var(--text-primary)]">{u.full_name || 'Unnamed user'}</p>
                          <p className="truncate text-xs text-[var(--text-muted)]">{u.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <Badge variant={u.role === 'admin' ? 'info' : 'neutral'} size="sm">
                        {u.role}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-[var(--text-secondary)]">
                      {tripCounts?.get(u.id) ?? 0}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-[var(--text-secondary)]">
                      {formatDate(u.created_at)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      <Button variant="ghost" size="sm" onClick={() => setSelectedUser(u)}>
                        View trips
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {selectedUser && <ViewUserTripsModal isOpen onClose={() => setSelectedUser(null)} user={selectedUser} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Invitations tab (admin)
// ---------------------------------------------------------------------------

function invitationStatus(inv: Invitation): 'active' | 'pending_verification' | 'completed' | 'expired' {
  if (inv.status) return inv.status
  if (inv.used_by) return 'completed'
  if (inv.expires_at && new Date(inv.expires_at) < new Date()) return 'expired'
  return 'active'
}

const INVITATION_BADGE: Record<string, { label: string; variant: 'success' | 'warning' | 'error' | 'neutral' }> = {
  active: { label: 'Active', variant: 'success' },
  pending_verification: { label: 'Pending email', variant: 'warning' },
  completed: { label: 'Completed', variant: 'neutral' },
  expired: { label: 'Expired', variant: 'error' },
}

function invitationLink(code: string): string {
  // Invitation links open the PUBLIC trip teaser first (UX_REDESIGN Part 2
  // "Invite → join funnel"); the teaser hands off to /signup?code=….
  return `${window.location.origin}${import.meta.env.BASE_URL}join/${code}`
}

function AdminInvitationsTab() {
  const { showToast } = useToast()
  const { data: invitations, isLoading } = useInvitations()
  const { data: trips } = useTrips()
  const deleteInvitation = useDeleteInvitation()
  const [createOpen, setCreateOpen] = useState(false)
  const [createKey, setCreateKey] = useState(0)
  const [pendingDelete, setPendingDelete] = useState<Invitation | null>(null)

  const counts = useMemo(() => {
    const c = { active: 0, pending_verification: 0, completed: 0, expired: 0 }
    for (const inv of invitations ?? []) c[invitationStatus(inv)]++
    return c
  }, [invitations])

  const copyLink = async (code: string) => {
    try {
      await navigator.clipboard.writeText(invitationLink(code))
      showToast({ type: 'success', message: 'Invitation link copied' })
    } catch {
      showToast({ type: 'error', message: 'Could not copy link' })
    }
  }

  const handleDelete = async () => {
    if (!pendingDelete) return
    try {
      await deleteInvitation.mutateAsync(pendingDelete.id)
      showToast({ type: 'success', message: 'Invitation deleted' })
      setPendingDelete(null)
    } catch (err) {
      showToast({ type: 'error', message: 'Could not delete invitation', description: (err as Error).message })
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton variant="card" height={80} />
        <Skeleton variant="list" lines={4} />
      </div>
    )
  }

  const openCreate = () => {
    setCreateKey((k) => k + 1)
    setCreateOpen(true)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-[var(--text-primary)]">Invitations</h2>
          <p className="text-sm text-[var(--text-secondary)]">Codes that let new people join</p>
        </div>
        <Button onClick={openCreate}>+ Create invitation</Button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Active" value={String(counts.active)} icon={<span>🟢</span>} size="sm" />
        <StatCard label="Pending email" value={String(counts.pending_verification)} icon={<span>✉️</span>} size="sm" />
        <StatCard label="Completed" value={String(counts.completed)} icon={<span>✅</span>} size="sm" />
        <StatCard label="Expired" value={String(counts.expired)} icon={<span>⌛</span>} size="sm" />
      </div>

      {(invitations ?? []).length === 0 ? (
        <Card>
          <Card.Content className="py-12">
            <EmptyState
              icon="🎫"
              title="No invitations yet"
              description="Create an invitation code so new people can sign up and join a trip."
              action={<Button onClick={openCreate}>Create first invitation</Button>}
            />
          </Card.Content>
        </Card>
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-[var(--border-subtle)] bg-[var(--surface-sunken)]">
                <tr>
                  {['Code', 'Status', 'Expires', 'Created', ''].map((h, i) => (
                    <th
                      key={i}
                      className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {(invitations ?? []).map((invitation) => {
                  const status = invitationStatus(invitation)
                  const badge = INVITATION_BADGE[status]
                  return (
                    <tr key={invitation.id} className="transition-colors hover:bg-[var(--surface-sunken)]">
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-sm text-[var(--text-primary)]">
                        {invitation.code}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <Badge variant={badge.variant} size="sm">
                          {badge.label}
                        </Badge>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-[var(--text-secondary)]">
                        {invitation.expires_at ? formatDate(invitation.expires_at) : 'Never'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-[var(--text-secondary)]">
                        {formatDate(invitation.created_at)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => copyLink(invitation.code)}>
                            Copy link
                          </Button>
                          <Button variant="ghost" size="sm" className="text-danger-600" onClick={() => setPendingDelete(invitation)}>
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <CreateInvitationSheet key={createKey} isOpen={createOpen} onClose={() => setCreateOpen(false)} trips={trips ?? []} />

      {pendingDelete && (
        <Modal isOpen onClose={() => setPendingDelete(null)} size="sm" title="Delete this invitation?">
          <div className="space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">
              {invitationStatus(pendingDelete) === 'active'
                ? `"${pendingDelete.code}" is still active and can be used to sign up — once deleted, the code stops working.`
                : `Delete ${invitationStatus(pendingDelete).replace(/_/g, ' ')} invitation "${pendingDelete.code}"? This can't be undone.`}
            </p>
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setPendingDelete(null)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={handleDelete} isLoading={deleteInvitation.isPending}>
                Delete invitation
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Create-invitation sheet (Form & Flow Standard): trip + expiry, then the
// created code with a one-tap copy-link. Same create_invitation RPC as the
// legacy modal, via the shared hook.
// ---------------------------------------------------------------------------

interface InvitationFormValues {
  tripId: string
  expiresInDays: string
}

function CreateInvitationSheet({ isOpen, onClose, trips }: { isOpen: boolean; onClose: () => void; trips: Trip[] }) {
  const { showToast } = useToast()
  const createInvitation = useCreateInvitation()
  const [createdCode, setCreatedCode] = useState<string | null>(null)

  const initial: InvitationFormValues = { tripId: '', expiresInDays: '7' }
  const { values, updateField, clearDraft } = useFormDraft<InvitationFormValues>('admin-create-invitation', initial)
  const isDirty = !createdCode && JSON.stringify(values) !== JSON.stringify(initial)
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isDirty)
  const handleClose = () => confirmClose(onClose)

  const handleCreate = async () => {
    if (!values.tripId) {
      showToast({ type: 'error', message: 'Pick a trip for the invitation' })
      return
    }
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + parseInt(values.expiresInDays, 10))
    try {
      const data = await createInvitation.mutateAsync({ tripId: values.tripId, expiresAt: expiresAt.toISOString() })
      setCreatedCode((data as { code: string }).code)
      clearDraft()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not create invitation', description: (err as Error).message })
    }
  }

  const handleCopyCreated = async () => {
    if (!createdCode) return
    try {
      await navigator.clipboard.writeText(invitationLink(createdCode))
      showToast({ type: 'success', message: 'Invitation link copied' })
      onClose()
    } catch {
      showToast({ type: 'error', message: 'Could not copy link' })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={createdCode ? onClose : handleClose} size="md" title="Create invitation">
      {createdCode ? (
        <div className="space-y-4">
          <div className="rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-4 text-center">
            <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Invitation code</p>
            <p className="mt-1 font-mono text-2xl font-semibold text-[var(--text-primary)]">{createdCode}</p>
            <p className="mt-2 break-all text-xs text-[var(--text-muted)]">{invitationLink(createdCode)}</p>
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={onClose}>
              Done
            </Button>
            <Button onClick={handleCopyCreated}>📋 Copy link</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <Select
            label="Trip"
            value={values.tripId}
            onChange={(e) => updateField('tripId', e.target.value)}
            options={[
              { value: '', label: 'Choose a trip…', disabled: true },
              ...trips.map((t) => ({ value: t.id, label: t.name })),
            ]}
          />
          <div className="grid grid-cols-2 items-end gap-3">
            <Select
              label="Expires in"
              value={values.expiresInDays}
              onChange={(e) => updateField('expiresInDays', e.target.value)}
              options={[
                { value: '1', label: '1 day' },
                { value: '3', label: '3 days' },
                { value: '7', label: '7 days' },
                { value: '14', label: '14 days' },
                { value: '30', label: '30 days' },
              ]}
            />
            <Input
              label="Expiry date"
              value={new Date(Date.now() + parseInt(values.expiresInDays, 10) * 86400000).toLocaleDateString('en-GB')}
              disabled
            />
          </div>
          <div className="flex justify-end gap-3 border-t border-[var(--border-subtle)] pt-3">
            <Button variant="ghost" onClick={handleClose} disabled={createInvitation.isPending}>
              Cancel
            </Button>
            <Button onClick={handleCreate} isLoading={createInvitation.isPending}>
              Create invitation
            </Button>
          </div>
        </div>
      )}

      <ConfirmDiscardSheet
        isOpen={guardProps.showConfirm}
        onKeep={guardProps.onKeep}
        onDiscard={() => {
          clearDraft()
          guardProps.onDiscard()
        }}
      />
    </Modal>
  )
}
