import { FormEvent, useState } from 'react'
import { Badge, Button, Card, EmptyState, Input, Modal, Skeleton, TextArea, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { announcementState, AnnouncementState } from '../lib/visibility'
import {
  AdminAnnouncement,
  useAdminAnnouncements,
  useCreateAnnouncement,
  useDeleteAnnouncement,
  useUpdateAnnouncement,
} from '../lib/useAnnouncements'

const stateBadge: Record<AnnouncementState, { variant: 'success' | 'info' | 'neutral'; label: string }> = {
  active: { variant: 'success', label: 'Active' },
  scheduled: { variant: 'info', label: 'Scheduled' },
  expired: { variant: 'neutral', label: 'Expired' },
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB')
}

/** timestamptz for the end of the picked day, so an announcement "ending 2 Aug" runs through 2 Aug. */
function endOfDayIso(dateInput: string): string {
  return new Date(`${dateInput}T23:59:59`).toISOString()
}

interface FormState {
  title: string
  body_md: string
  /** yyyy-MM-dd (native date input). */
  endDate: string
}

const emptyForm: FormState = { title: '', body_md: '', endDate: '' }

/**
 * Dashboard → Announcements tab (admins only — the Dashboard only renders
 * admin tabs for users.role === 'admin', and RLS enforces writes
 * server-side). Minimal CRUD over site_announcements: list with
 * active/scheduled/expired state + how many users dismissed each, create
 * (title, markdown body, end date), edit body/end date, delete.
 */
export function AdminAnnouncementsTab() {
  const { user } = useAuth()
  const { showToast } = useToast()
  const { data: announcements, isLoading } = useAdminAnnouncements(!!user)
  const createAnnouncement = useCreateAnnouncement()
  const updateAnnouncement = useUpdateAnnouncement()
  const deleteAnnouncement = useDeleteAnnouncement()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<AdminAnnouncement | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [deleting, setDeleting] = useState<AdminAnnouncement | null>(null)

  const openCreate = () => {
    setEditing(null)
    setForm(emptyForm)
    setFormOpen(true)
  }

  const openEdit = (announcement: AdminAnnouncement) => {
    setEditing(announcement)
    setForm({
      title: announcement.title,
      body_md: announcement.body_md,
      endDate: announcement.ends_at.slice(0, 10),
    })
    setFormOpen(true)
  }

  const closeForm = () => {
    setFormOpen(false)
    setEditing(null)
  }

  const saving = createAnnouncement.isPending || updateAnnouncement.isPending

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!user || saving) return
    try {
      if (editing) {
        await updateAnnouncement.mutateAsync({
          id: editing.id,
          patch: { body_md: form.body_md.trim(), ends_at: endOfDayIso(form.endDate) },
        })
        showToast({ type: 'success', message: 'Announcement updated' })
      } else {
        await createAnnouncement.mutateAsync({
          title: form.title.trim(),
          body_md: form.body_md.trim(),
          ends_at: endOfDayIso(form.endDate),
          created_by: user.id,
        })
        showToast({ type: 'success', message: 'Announcement published', description: 'Everyone sees it once on their next visit.' })
      }
      closeForm()
    } catch (err) {
      showToast({ type: 'error', message: 'Save failed', description: (err as Error)?.message || 'Please try again' })
    }
  }

  const handleDelete = async () => {
    if (!deleting) return
    try {
      await deleteAnnouncement.mutateAsync(deleting.id)
      showToast({ type: 'success', message: 'Announcement deleted' })
      setDeleting(null)
    } catch (err) {
      showToast({ type: 'error', message: 'Delete failed', description: (err as Error)?.message || 'Please try again' })
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton variant="card" height={80} />
        <Skeleton variant="card" height={160} />
      </div>
    )
  }

  const canSubmit = (editing || form.title.trim()) && form.body_md.trim() && form.endDate

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-[var(--text-primary)]">Site announcements</h2>
          <p className="text-sm text-[var(--text-secondary)]">One-time popups every user sees once while active</p>
        </div>
        <Button onClick={openCreate}>+ New announcement</Button>
      </div>

      {!announcements || announcements.length === 0 ? (
        <Card>
          <Card.Content className="py-12">
            <EmptyState
              icon="📢"
              title="No announcements yet"
              description="Publish one and every user sees it once as a popup while it's active."
              action={<Button onClick={openCreate}>New announcement</Button>}
            />
          </Card.Content>
        </Card>
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-[var(--border-subtle)] bg-[var(--surface-sunken)]">
                <tr>
                  {['Announcement', 'Status', 'Window', 'Dismissed by', ''].map((h, i) => (
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
                {announcements.map((announcement) => {
                  const state = announcementState(announcement)
                  const badge = stateBadge[state]
                  return (
                    <tr key={announcement.id}>
                      <td className="max-w-xs px-4 py-3">
                        <p className="truncate font-medium text-[var(--text-primary)]">{announcement.title}</p>
                        <p className="truncate text-xs text-[var(--text-muted)]">{announcement.body_md}</p>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <Badge variant={badge.variant} size="sm">
                          {badge.label}
                        </Badge>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-[var(--text-secondary)]">
                        {formatDate(announcement.starts_at)} – {formatDate(announcement.ends_at)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-[var(--text-secondary)]">
                        👁️ {announcement.dismissal_count}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(announcement)}>
                          Edit
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeleting(announcement)}>
                          Delete
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

      <Modal isOpen={formOpen} onClose={closeForm} title={editing ? 'Edit announcement' : 'New announcement'} size="md">
        <form onSubmit={handleSubmit} className="space-y-4">
          {editing ? (
            <p className="text-sm font-medium text-[var(--text-primary)]">{editing.title}</p>
          ) : (
            <Input
              label="Title"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="👋 Welcome to the new home"
              maxLength={200}
              required
            />
          )}
          <TextArea
            label="Body (markdown)"
            value={form.body_md}
            onChange={(e) => setForm((f) => ({ ...f, body_md: e.target.value }))}
            rows={6}
            maxLength={5000}
            required
          />
          <Input
            label="Ends on"
            type="date"
            value={form.endDate}
            onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
            required
          />
          <div className="flex justify-end gap-3">
            <Button type="button" variant="ghost" onClick={closeForm} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" isLoading={saving} disabled={!canSubmit}>
              {editing ? 'Save changes' : 'Publish'}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={!!deleting} onClose={() => setDeleting(null)} size="sm" title="Delete announcement?">
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            "{deleting?.title}" will disappear for everyone, along with who has seen it.
          </p>
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setDeleting(null)} disabled={deleteAnnouncement.isPending}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete} isLoading={deleteAnnouncement.isPending}>
              Delete
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
