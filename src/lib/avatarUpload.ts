/**
 * Avatar system v2 (UX_REDESIGN.md "Avatar system v2", part (a)/(c)): photo
 * upload pipeline for the "Photo" avatar tab. Mirrors the shape of
 * `receiptUpload.ts` (dynamic imports for the heavy libs, HEIC handling)
 * but targets the public `avatars` bucket at a fixed per-user path so a new
 * upload always overwrites the previous one (`upsert: true`) rather than
 * accumulating orphaned files.
 */
import { supabase } from './supabase'

const MAX_AVATAR_SIZE_BYTES = 200 * 1024 // 200KB, per spec
const AVATAR_DIMENSION_PX = 512

/**
 * Convert HEIC/HEIF to JPEG first (iPhone photos), matching
 * `receiptUpload.ts`'s convention -- dynamic import so `heic-to` is only
 * fetched when actually needed.
 */
async function convertHeicToJpegIfNeeded(file: File): Promise<File> {
  const { isHeic } = await import('heic-to')
  if (!(await isHeic(file))) return file

  const { heicTo } = await import('heic-to')
  const blob = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.9 })
  const fileName = file.name.replace(/\.(heic|heif)$/i, '.jpg')
  return new File([blob], fileName, { type: 'image/jpeg' })
}

/**
 * Square center-crops an image file to `AVATAR_DIMENSION_PX`x`AVATAR_DIMENSION_PX`
 * using a canvas, returning a new File. Runs entirely client-side (no
 * network) so the preview shown to the user before upload matches exactly
 * what gets uploaded.
 */
export async function centerCropSquare(file: File, size = AVATAR_DIMENSION_PX): Promise<File> {
  const objectUrl = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('Could not read image'))
      el.src = objectUrl
    })

    const side = Math.min(img.naturalWidth, img.naturalHeight)
    const sx = (img.naturalWidth - side) / 2
    const sy = (img.naturalHeight - side) / 2

    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas not supported')
    ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size)

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
    if (!blob) throw new Error('Could not encode cropped image')

    return new File([blob], 'avatar.jpg', { type: 'image/jpeg' })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

/**
 * Compresses an (already square-cropped) image down to <=200KB. Dynamic
 * import so `browser-image-compression` (~850KB unpacked) only loads when
 * a user actually picks a photo, matching the code-splitting rationale in
 * `receiptUpload.ts`.
 */
async function compressAvatar(file: File): Promise<File> {
  const { default: imageCompression } = await import('browser-image-compression')
  return imageCompression(file, {
    maxSizeMB: MAX_AVATAR_SIZE_BYTES / (1024 * 1024),
    maxWidthOrHeight: AVATAR_DIMENSION_PX,
    useWebWorker: true,
    fileType: 'image/jpeg',
  })
}

/**
 * Full pipeline: HEIC-convert -> square-crop -> compress -> upload to
 * `avatars/{uid}/avatar.jpg` (fixed path, `upsert: true`) -> return a
 * cache-busted public URL ready to save straight into `users.avatar_url`.
 */
export async function processAndUploadAvatar(file: File, userId: string): Promise<string> {
  let processed = await convertHeicToJpegIfNeeded(file)
  processed = await centerCropSquare(processed)
  processed = await compressAvatar(processed)

  if (processed.size > MAX_AVATAR_SIZE_BYTES * 1.1) {
    // Small tolerance above the target -- browser-image-compression aims
    // for maxSizeMB but isn't always exact; only fail if it's meaningfully over.
    throw new Error('Image still too large after compression. Try a different photo.')
  }

  const path = `${userId}/avatar.jpg`
  const { error } = await supabase.storage
    .from('avatars')
    .upload(path, processed, { cacheControl: '3600', upsert: true, contentType: 'image/jpeg' })

  if (error) {
    throw new Error(`Upload failed: ${error.message}`)
  }

  const { data } = supabase.storage.from('avatars').getPublicUrl(path)
  // Cache-bust so the new photo shows immediately everywhere it's
  // rendered, even though the underlying object path never changes.
  return `${data.publicUrl}?v=${Date.now()}`
}
