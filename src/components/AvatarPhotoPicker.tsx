import { useEffect, useRef, useState } from 'react'
import { Button } from './ui'
import { centerCropSquare } from '../lib/avatarUpload'

interface AvatarPhotoPickerProps {
  /** Currently-saved photo URL (if any), shown before a new file is picked. */
  currentUrl?: string | null
  /** Called with the square-cropped File once the user picks + confirms a photo. */
  onFileReady: (file: File | null) => void
  disabled?: boolean
}

/**
 * Avatar system v2 "Photo" tab (UX_REDESIGN.md "Avatar system v2" (a)/(d)):
 * file pick -> square center-crop preview, entirely client-side. The actual
 * compress+upload happens on Save (see ProfileModal), not here -- this
 * component's job is just "get a cropped File into parent state and show a
 * preview", matching the Form & Flow Standard's "fresh state, no premature
 * side effects until Save" spirit.
 */
export function AvatarPhotoPicker({ currentUrl, onFileReady, disabled }: AvatarPhotoPickerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cropping, setCropping] = useState(false)

  const handleFilePicked = async (file: File) => {
    setError(null)
    setCropping(true)
    try {
      const cropped = await centerCropSquare(file)
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(cropped)
      })
      onFileReady(cropped)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that image')
      onFileReady(null)
    } finally {
      setCropping(false)
    }
  }

  // Revoke the blob URL on unmount too (e.g. the modal is closed while a
  // freshly-picked preview is showing), not just when replaced/removed.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const displayUrl = previewUrl || currentUrl

  return (
    <div className="space-y-4">
      <div className="flex justify-center">
        <div className="w-24 h-24 rounded-full overflow-hidden bg-[var(--surface-sunken)] flex items-center justify-center">
          {displayUrl ? (
            <img src={displayUrl} alt="Avatar preview" className="w-full h-full object-cover" />
          ) : (
            <span className="text-[var(--text-muted)] text-xs">No photo</span>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-danger-600 text-center">{error}</p>}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/jpg,image/png,image/heic,image/heif"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void handleFilePicked(file)
          e.target.value = ''
        }}
      />

      <div className="flex justify-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          isLoading={cropping}
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
        >
          {displayUrl ? 'Choose a different photo' : 'Choose a photo'}
        </Button>
        {previewUrl && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => {
              URL.revokeObjectURL(previewUrl)
              setPreviewUrl(null)
              onFileReady(null)
            }}
          >
            Remove
          </Button>
        )}
      </div>

      <p className="text-xs text-[var(--text-muted)] text-center">
        Square photos work best — we'll center-crop it for you.
      </p>
    </div>
  )
}
