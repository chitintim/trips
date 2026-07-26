import { useState, FormEvent } from 'react'
import { Modal, Button, Input, SegmentedControl, ConfirmDiscardSheet, Avatar } from './ui'
import { AvatarBuilder } from './AvatarBuilder'
import { AvatarIconPicker } from './AvatarIconPicker'
import { AvatarPhotoPicker } from './AvatarPhotoPicker'
import { supabase } from '../lib/supabase'
import { useUnsavedChangesGuard } from '../lib/forms'
import { processAndUploadAvatar } from '../lib/avatarUpload'
import { resolveAvatar, type AvatarIconName } from './ui/Avatar'
import { AvatarData, User, UserUpdate } from '../types'

interface ProfileModalProps {
  isOpen: boolean
  onClose: () => void
  user: User
  onUpdate: () => void
}

type AvatarTab = 'photo' | 'icons' | 'emoji'

const DEFAULT_EMOJI: AvatarData = { emoji: '😊', accessory: null, bgColor: '#0ea5e9' }
const DEFAULT_ICON: { icon: AvatarIconName; bgColor: string } = { icon: 'mountain', bgColor: '#0ea5e9' }

/** localStorage key for the one-time "give your avatar a refresh" hint. */
const REFRESH_HINT_DISMISSED_KEY = 'trips:avatar-refresh-hint-dismissed'

function initialTabFor(user: User): AvatarTab {
  const resolved = resolveAvatar({ avatarUrl: user.avatar_url, avatarData: user.avatar_data })
  if (resolved.kind === 'photo') return 'photo'
  if (resolved.kind === 'icon') return 'icons'
  return 'emoji'
}

/** True only for the legacy pre-v2 shape: an emoji avatar with no photo. */
function isLegacyEmojiOnly(user: User): boolean {
  const resolved = resolveAvatar({ avatarUrl: user.avatar_url, avatarData: user.avatar_data })
  return resolved.kind === 'emoji' || resolved.kind === 'initials'
}

export function ProfileModal({ isOpen, onClose, user, onUpdate }: ProfileModalProps) {
  const [firstName, setFirstName] = useState(user.first_name || '')
  const [lastName, setLastName] = useState(user.last_name || '')
  const [emailNotificationsEnabled, setEmailNotificationsEnabled] = useState(
    user.email_notifications_enabled ?? true
  )

  // Email change is handled entirely separately from the name/avatar/
  // notifications form below -- it goes through supabase.auth.updateUser(),
  // which only sends a confirmation link and does NOT touch auth.users.email
  // (let alone public.users.email) until the user clicks it. Bundling it
  // into the main Save would wrongly imply an immediate change, and a failed
  // name/avatar save should never block or retry an email confirmation that
  // already went out. public.users.email catches up on its own once the
  // change is confirmed (DB trigger, see 20260726051224_sync_user_email_on_change.sql).
  const [newEmail, setNewEmail] = useState('')
  const [emailChangeLoading, setEmailChangeLoading] = useState(false)
  const [emailChangeError, setEmailChangeError] = useState<string | null>(null)
  const [emailChangeSentTo, setEmailChangeSentTo] = useState<string | null>(null)

  const [avatarTab, setAvatarTab] = useState<AvatarTab>(() => initialTabFor(user))

  // Photo tab: a freshly-picked (cropped, not-yet-uploaded) file, or null if
  // the user hasn't picked a new one this session (existing avatar_url still
  // shown via `currentUrl`). AvatarPhotoPicker owns its own preview object
  // URL and revokes it internally -- this is just the File to upload on Save.
  const [pendingPhotoFile, setPendingPhotoFile] = useState<File | null>(null)

  // Icons tab state.
  const initialIcon = (() => {
    const resolved = resolveAvatar({ avatarUrl: user.avatar_url, avatarData: user.avatar_data })
    return resolved.kind === 'icon' ? { icon: resolved.icon, bgColor: resolved.bgColor } : DEFAULT_ICON
  })()
  const [iconChoice, setIconChoice] = useState(initialIcon)

  // Emoji (legacy) tab state -- unchanged builder, kept for existing users.
  const [avatarData, setAvatarData] = useState<AvatarData>(() => {
    const data = user.avatar_data as Partial<AvatarData> | null
    return data && typeof data === 'object' && 'emoji' in data ? (data as AvatarData) : DEFAULT_EMOJI
  })

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const [hintDismissed, setHintDismissed] = useState(
    () => localStorage.getItem(REFRESH_HINT_DISMISSED_KEY) === '1'
  )
  const dismissHint = () => {
    localStorage.setItem(REFRESH_HINT_DISMISSED_KEY, '1')
    setHintDismissed(true)
  }

  const isDirty =
    !success &&
    (firstName !== (user.first_name || '') ||
      lastName !== (user.last_name || '') ||
      pendingPhotoFile !== null ||
      (avatarTab === 'icons' && (iconChoice.icon !== initialIcon.icon || iconChoice.bgColor !== initialIcon.bgColor)) ||
      (avatarTab === 'emoji' && JSON.stringify(avatarData) !== JSON.stringify(user.avatar_data ?? DEFAULT_EMOJI)) ||
      (avatarTab !== initialTabFor(user)) ||
      emailNotificationsEnabled !== (user.email_notifications_enabled ?? true))
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isDirty)
  const handleClose = () => confirmClose(onClose)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    setLoading(true)

    try {
      const update: UserUpdate = {
        first_name: firstName,
        last_name: lastName,
        full_name: `${firstName} ${lastName}`,
        email_notifications_enabled: emailNotificationsEnabled,
      }

      if (avatarTab === 'photo' && pendingPhotoFile) {
        // Upload happens on Save, not on file pick -- keeps a failed/slow
        // upload from silently leaving the modal in a half-saved state.
        const publicUrl = await processAndUploadAvatar(pendingPhotoFile, user.id)
        update.avatar_url = publicUrl
        // Photo keeps whatever avatar_data was already there as a fallback
        // (per spec: "saving photo keeps avatar_data as fallback") -- don't
        // touch it.
      } else if (avatarTab === 'icons') {
        update.avatar_data = { type: 'icon', icon: iconChoice.icon, bgColor: iconChoice.bgColor } as unknown as UserUpdate['avatar_data']
        update.avatar_url = null // icon/emoji saves clear avatar_url (spec)
      } else if (avatarTab === 'emoji') {
        update.avatar_data = avatarData as unknown as UserUpdate['avatar_data']
        update.avatar_url = null
      }

      const { error: updateError } = await supabase
        .from('users')
        .update(update)
        .eq('id', user.id)

      if (updateError) {
        setError(updateError.message)
        return
      }

      setSuccess(true)
      onUpdate() // Refresh user data

      // Close modal after brief success message
      setTimeout(() => {
        onClose()
        setSuccess(false)
      }, 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }

  const handleEmailChange = async () => {
    const trimmed = newEmail.trim()
    setEmailChangeError(null)
    setEmailChangeSentTo(null)

    if (!trimmed) {
      setEmailChangeError('Enter a new email address')
      return
    }
    if (trimmed.toLowerCase() === (user.email || '').toLowerCase()) {
      setEmailChangeError("That's already your email address")
      return
    }

    setEmailChangeLoading(true)
    try {
      // Sends a confirmation link to `trimmed` -- auth.users.email (and thus
      // public.users.email, via the DB trigger) is untouched until it's
      // clicked. Surface the server's own error text (e.g.
      // "email_address_invalid") rather than a generic message.
      const { error } = await supabase.auth.updateUser({ email: trimmed })
      if (error) {
        setEmailChangeError(error.message)
        return
      }
      setEmailChangeSentTo(trimmed)
      setNewEmail('')
    } catch (err) {
      setEmailChangeError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setEmailChangeLoading(false)
    }
  }

  const showRefreshHint = !hintDismissed && isLegacyEmojiOnly(user) && avatarTab === 'emoji'

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Edit Profile">
      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="bg-danger-50 border border-danger-200 text-danger-800 rounded-[var(--radius-md)] p-3 text-sm">
            {error}
          </div>
        )}

        {success && (
          <div className="bg-success-50 border border-success-200 text-success-800 rounded-[var(--radius-md)] p-3 text-sm">
            Profile updated successfully!
          </div>
        )}

        {/* First Name */}
        <Input
          label="First Name"
          type="text"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          placeholder="Tim"
          required
          disabled={loading}
        />

        {/* Last Name */}
        <Input
          label="Last Name"
          type="text"
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          placeholder="Lam"
          required
          disabled={loading}
        />

        {/* Email address -- deliberately its own mini-form, separate from
            Save Changes below: it goes through Supabase Auth (a confirmation
            link, not an immediate write), so it needs its own pending/error
            state and must never be retried by an unrelated name/avatar save. */}
        <div className="space-y-2 rounded-[var(--radius-md)] border border-[var(--border-default)] p-3">
          <label className="block text-sm font-medium text-[var(--text-secondary)]">Email address</label>
          <p className="text-sm text-[var(--text-primary)]">
            Signed in as <strong>{user.email}</strong>
          </p>

          {emailChangeError && (
            <div className="bg-danger-50 border border-danger-200 text-danger-800 rounded-[var(--radius-md)] p-3 text-sm">
              {emailChangeError}
            </div>
          )}

          {emailChangeSentTo && (
            <div className="bg-success-50 border border-success-200 text-success-800 rounded-[var(--radius-md)] p-3 text-sm">
              We've sent a confirmation link to <strong>{emailChangeSentTo}</strong>. Your sign-in email stays{' '}
              <strong>{user.email}</strong> until you click it — if this project also requires confirming from your
              current inbox, check that one too.
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-2 sm:items-start">
            <div className="flex-1">
              <Input
                type="email"
                value={newEmail}
                onChange={(e) => {
                  setNewEmail(e.target.value)
                  setEmailChangeError(null)
                  setEmailChangeSentTo(null)
                }}
                onKeyDown={(e) => {
                  // Prevent Enter from bubbling up to the outer form and
                  // triggering the unrelated "Save Changes" submit instead.
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleEmailChange()
                  }
                }}
                placeholder="new-email@example.com"
                disabled={emailChangeLoading}
                aria-label="New email address"
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={handleEmailChange}
              isLoading={emailChangeLoading}
              disabled={!newEmail.trim()}
            >
              Send confirmation
            </Button>
          </div>
        </div>

        {/* Avatar editor */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <label className="block text-sm font-medium text-[var(--text-secondary)]">Your Avatar</label>
            <SegmentedControl
              size="sm"
              value={avatarTab}
              onChange={setAvatarTab}
              options={[
                { value: 'photo', label: 'Photo' },
                { value: 'icons', label: 'Icons' },
                { value: 'emoji', label: 'Emoji' },
              ]}
            />
          </div>

          {showRefreshHint && (
            <div className="mb-3 flex items-start gap-2 rounded-[var(--radius-md)] border border-accent-200 bg-accent-50 p-3 text-sm text-accent-900 dark:border-accent-800 dark:bg-accent-950 dark:text-accent-200">
              <span aria-hidden="true">✨</span>
              <p className="flex-1">Give your avatar a refresh — try a photo or one of our new travel icons.</p>
              <button
                type="button"
                onClick={dismissHint}
                className="shrink-0 text-accent-700 hover:text-accent-900 dark:text-accent-300"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          )}

          {avatarTab === 'photo' && (
            <AvatarPhotoPicker
              currentUrl={user.avatar_url}
              onFileReady={setPendingPhotoFile}
              disabled={loading}
            />
          )}

          {avatarTab === 'icons' && (
            <AvatarIconPicker
              icon={iconChoice.icon}
              bgColor={iconChoice.bgColor}
              onChange={setIconChoice}
              disabled={loading}
            />
          )}

          {avatarTab === 'emoji' && (
            <AvatarBuilder value={avatarData} onChange={setAvatarData} disabled={loading} />
          )}
        </div>

        {/* Live preview of what will actually render app-wide -- the Photo
            tab already shows its own crop preview above, so this is only
            needed for Icons/Emoji. */}
        {avatarTab !== 'photo' && (
          <div className="flex items-center justify-center gap-3 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3">
            <Avatar
              size="lg"
              alt="Preview"
              avatarData={avatarTab === 'icons' ? { type: 'icon', icon: iconChoice.icon, bgColor: iconChoice.bgColor } : avatarData}
            />
            <span className="text-sm text-[var(--text-muted)]">This is how you'll appear to others</span>
          </div>
        )}

        {/* Notifications -- a single opt-out toggle (rather than separate
            switches per email kind): trips.chase_settings already lets an
            organizer split "bundled chase" from "action reminders" per trip,
            but at the account level one clear switch is enough. Saved
            together with name/avatar below; enforced server-side in
            auto-chase (users.email_notifications_enabled), never affects
            auth emails (confirmation / password reset), which don't go
            through auto-chase at all. */}
        <label className="flex items-start gap-3 cursor-pointer rounded-[var(--radius-md)] border border-[var(--border-default)] p-3">
          <input
            type="checkbox"
            checked={emailNotificationsEnabled}
            onChange={(e) => setEmailNotificationsEnabled(e.target.checked)}
            disabled={loading}
            className="mt-1 w-5 h-5 accent-accent-600"
          />
          <span>
            <span className="block text-sm font-medium text-[var(--text-primary)]">Email notifications</span>
            <span className="block text-xs text-[var(--text-muted)] mt-0.5">
              Trip reminders, chase emails, and action deadline nudges. Turning this off stops all of them at once —
              account emails like sign-in confirmation and password reset are unaffected and always send.
            </span>
          </span>
        </label>

        {/* Buttons */}
        <div className="flex gap-3 justify-end pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            isLoading={loading}
          >
            Save Changes
          </Button>
        </div>
      </form>

      <ConfirmDiscardSheet isOpen={guardProps.showConfirm} onKeep={guardProps.onKeep} onDiscard={guardProps.onDiscard} />
    </Modal>
  )
}
