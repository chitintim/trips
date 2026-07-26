import { useState } from 'react'
import { Badge, Button, Input, Modal, useToast } from './ui'
import {
  useAdminInvitationAccountAction,
  type InvitationAdminDetail,
} from '../lib/queries/useInvitationAdminAccounts'
import type { AdminInvitationAccountAction } from '../shared/contracts/adminInvitationAccount'
import { accountStatusBadges } from '../lib/invitationAccountStatus'

function formatDateTime(date: string | null): string {
  if (!date) return '—'
  return new Date(date).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
}

interface PendingConfirm {
  action: AdminInvitationAccountAction
  title: string
  message: string
  email?: string
  successMessage: string
}

interface ManageInvitationAccountSheetProps {
  isOpen: boolean
  onClose: () => void
  /** The invitation-admin-details row for the account being managed. Only
   *  ever rendered by the caller when this is non-null (see AdminInvitationsTab),
   *  but kept nullable here so a mid-session refetch that drops the row
   *  (e.g. the invitation got deleted elsewhere) degrades to "render
   *  nothing" instead of crashing. */
  detail: InvitationAdminDetail | null
}

/**
 * Site-admin drill-down for one invitation's produced account (Dashboard's
 * Invitations tab) -- surfaces exactly what happened after signup (name,
 * email, confirmed?, ever logged in?) and lets an admin fix a stuck account
 * via the admin-invitation-account edge function: resend the confirmation
 * email, correct a typo'd email, manually mark confirmed (no email sent),
 * or fix a display name.
 *
 * Real motivating case: chrisceungsc123@gmail.com signed up, never
 * confirmed, never logged in -- the old Invitations tab gave the admin no
 * way to see why or fix it. This sheet exists to close that gap.
 */
export function ManageInvitationAccountSheet({ isOpen, onClose, detail }: ManageInvitationAccountSheetProps) {
  const { showToast } = useToast()
  const accountAction = useAdminInvitationAccountAction()

  const [fullNameDraft, setFullNameDraft] = useState(detail?.account_full_name || '')
  const [emailDraft, setEmailDraft] = useState(detail?.account_email || '')
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  if (!detail || !detail.account_user_id) return null
  const userId = detail.account_user_id

  const fullNameChanged =
    fullNameDraft.trim().length > 0 && fullNameDraft.trim() !== (detail.account_full_name || '').trim()
  const emailChanged = emailDraft.trim().length > 0 && emailDraft.trim() !== (detail.account_email || '').trim()

  const runAction = async (
    request: { action: AdminInvitationAccountAction; email?: string; full_name?: string },
    successMessage: string
  ) => {
    setActionError(null)
    try {
      await accountAction.mutateAsync({ user_id: userId, ...request })
      showToast({ type: 'success', message: successMessage })
    } catch (err) {
      // Surface the REAL server error text (e.g. "email_address_invalid")
      // both inline (persistent, hard to miss) and as a toast.
      const message = (err as Error).message
      setActionError(message)
      showToast({ type: 'error', message: 'Action failed', description: message })
    } finally {
      setPendingConfirm(null)
    }
  }

  const badges = accountStatusBadges(detail)

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} size="md" title="Manage account">
        <div className="space-y-6">
          <div>
            <p className="text-lg font-semibold text-[var(--text-primary)]">{detail.account_full_name || 'Unnamed user'}</p>
            <p className="text-sm text-[var(--text-secondary)]">{detail.account_email}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {badges.map((b) => (
                <Badge key={b.label} variant={b.variant} size="sm">
                  {b.label}
                </Badge>
              ))}
            </div>
          </div>

          <dl className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Signed up</dt>
              <dd className="mt-0.5 text-[var(--text-secondary)]">{formatDateTime(detail.account_created_at)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Confirmed</dt>
              <dd className="mt-0.5 text-[var(--text-secondary)]">{formatDateTime(detail.account_email_confirmed_at)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Last login</dt>
              <dd className="mt-0.5 text-[var(--text-secondary)]">{formatDateTime(detail.account_last_sign_in_at)}</dd>
            </div>
          </dl>

          {actionError && (
            <div className="rounded-[var(--radius-md)] border border-danger-200 bg-danger-50 px-3 py-2 text-sm text-danger-700 dark:border-danger-800 dark:bg-danger-950 dark:text-danger-300">
              {actionError}
            </div>
          )}

          <div className="space-y-3 border-t border-[var(--border-subtle)] pt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Confirmation</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={accountAction.isPending}
                onClick={() =>
                  setPendingConfirm({
                    action: 'resend_confirmation',
                    title: 'Resend confirmation email?',
                    message: `Send a fresh "confirm your email" link to ${detail.account_email}? This is the same email GoTrue sends at signup -- nothing else changes.`,
                    successMessage: 'Confirmation email resent',
                  })
                }
              >
                Resend confirmation email
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={accountAction.isPending}
                onClick={() =>
                  setPendingConfirm({
                    action: 'confirm_email',
                    title: 'Mark email confirmed?',
                    message: `Mark ${detail.account_email} as confirmed WITHOUT sending anything. Only do this once you've verified this really is their address some other way -- there's no undo for this from here.`,
                    successMessage: 'Email marked confirmed',
                  })
                }
              >
                Mark confirmed (no email)
              </Button>
            </div>
          </div>

          <div className="space-y-2 border-t border-[var(--border-subtle)] pt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Full name</p>
            <div className="flex gap-2">
              <Input
                value={fullNameDraft}
                onChange={(e) => setFullNameDraft(e.target.value)}
                disabled={accountAction.isPending}
                fullWidth
                aria-label="Full name"
              />
              <Button
                variant="secondary"
                size="sm"
                disabled={accountAction.isPending || !fullNameChanged}
                onClick={() => runAction({ action: 'update_full_name', full_name: fullNameDraft.trim() }, 'Name updated')}
              >
                Save
              </Button>
            </div>
          </div>

          <div className="space-y-2 border-t border-[var(--border-subtle)] pt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Email</p>
            <p className="text-xs text-[var(--text-secondary)]">
              Changing the email keeps the account and all its trip data intact — it's the same underlying account id,
              just a corrected address. The new address will need to be reconfirmed afterwards (resend or mark
              confirmed).
            </p>
            <div className="flex gap-2">
              <Input
                type="email"
                value={emailDraft}
                onChange={(e) => setEmailDraft(e.target.value)}
                disabled={accountAction.isPending}
                fullWidth
                aria-label="Email"
              />
              <Button
                variant="secondary"
                size="sm"
                disabled={accountAction.isPending || !emailChanged}
                onClick={() =>
                  setPendingConfirm({
                    action: 'update_email',
                    title: "Change this account's email?",
                    message: `Change the email from ${detail.account_email} to ${emailDraft.trim()}? The account keeps the same id, so trip membership, votes and actions all stay attached — only the address changes. It will need to be reconfirmed afterwards.`,
                    email: emailDraft.trim(),
                    successMessage: 'Email updated',
                  })
                }
              >
                Save
              </Button>
            </div>
          </div>

          <div className="flex justify-end border-t border-[var(--border-subtle)] pt-4">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </Modal>

      {pendingConfirm && (
        <Modal isOpen onClose={() => setPendingConfirm(null)} size="sm" title={pendingConfirm.title}>
          <div className="space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">{pendingConfirm.message}</p>
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setPendingConfirm(null)} disabled={accountAction.isPending}>
                Cancel
              </Button>
              <Button
                onClick={() =>
                  runAction(
                    { action: pendingConfirm.action, email: pendingConfirm.email },
                    pendingConfirm.successMessage
                  )
                }
                isLoading={accountAction.isPending}
              >
                Confirm
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
