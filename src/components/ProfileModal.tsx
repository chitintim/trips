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
      (avatarTab !== initialTabFor(user)))
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

  const showRefreshHint = !hintDismissed && isLegacyEmojiOnly(user) && avatarTab === 'emoji'

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Edit Profile">
      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-sm">
            {error}
          </div>
        )}

        {success && (
          <div className="bg-green-50 border border-green-200 text-green-800 rounded-lg p-3 text-sm">
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
