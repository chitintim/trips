/**
 * Receipt Upload Utilities
 *
 * Handles:
 * - HEIC/HEIF to JPEG conversion (for iPhone photos)
 * - Image compression (reduce file size by 70-80%)
 * - Upload to Supabase Storage
 * - File validation
 */

import heic2any from 'heic2any'
import imageCompression from 'browser-image-compression'
import { supabase } from './supabase'

const MAX_FILE_SIZE_MB = 3 // Final size after compression
const MAX_ORIGINAL_FILE_SIZE_MB = 15 // Maximum original file size (before compression)
const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/heic', 'image/heif', 'application/pdf']

export interface UploadResult {
  url: string
  path: string
  size: number
}

/**
 * Convert HEIC/HEIF file to JPEG
 */
async function convertHeicToJpeg(file: File): Promise<File> {
  const isHeic = file.type === 'image/heic' ||
                 file.type === 'image/heif' ||
                 file.name.toLowerCase().endsWith('.heic') ||
                 file.name.toLowerCase().endsWith('.heif')

  if (!isHeic) {
    return file
  }

  try {
    console.log('Converting HEIC to JPEG...', {
      fileName: file.name,
      fileType: file.type,
      fileSize: (file.size / 1024 / 1024).toFixed(2) + 'MB'
    })

    const converted = await heic2any({
      blob: file,
      toType: 'image/jpeg',
      quality: 0.8
    })

    // heic2any can return Blob or Blob[]
    const blob = Array.isArray(converted) ? converted[0] : converted

    // Create new File from converted blob
    const fileName = file.name.replace(/\.(heic|heif)$/i, '.jpg')
    const convertedFile = new File([blob], fileName, { type: 'image/jpeg' })

    console.log('HEIC conversion successful:', {
      originalSize: (file.size / 1024 / 1024).toFixed(2) + 'MB',
      convertedSize: (convertedFile.size / 1024 / 1024).toFixed(2) + 'MB'
    })

    return convertedFile
  } catch (error: any) {
    console.error('HEIC conversion failed:', error)
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      fileName: file.name,
      fileType: file.type
    })

    // HEIC conversion is required - cannot proceed without it
    throw new Error(`Failed to convert HEIC image. This browser may not support HEIC conversion.\n\nPlease either:\n1. Use a different browser (Chrome/Edge recommended)\n2. Convert the image to JPEG manually before uploading\n3. Take a screenshot of the image and upload that instead\n\nTechnical details: ${error.message}`)
  }
}

/**
 * Compress image file
 */
async function compressImage(file: File): Promise<File> {
  // Don't compress PDFs
  if (file.type === 'application/pdf') {
    // Check PDF size
    const pdfSizeMB = file.size / 1024 / 1024
    if (pdfSizeMB > MAX_FILE_SIZE_MB) {
      throw new Error(`PDF too large (${pdfSizeMB.toFixed(1)}MB). Maximum: ${MAX_FILE_SIZE_MB}MB. Please compress the PDF before uploading.`)
    }
    return file
  }

  try {
    console.log('Compressing image...', {
      originalSize: (file.size / 1024 / 1024).toFixed(2) + 'MB'
    })

    const options = {
      maxSizeMB: 0.5, // Target 500KB
      maxWidthOrHeight: 1920,
      useWebWorker: true,
      fileType: file.type as any
    }

    const compressed = await imageCompression(file, options)
    const compressionRatio = ((1 - compressed.size / file.size) * 100).toFixed(0)

    console.log(`Compression successful: ${(file.size / 1024 / 1024).toFixed(2)}MB → ${(compressed.size / 1024 / 1024).toFixed(2)}MB (${compressionRatio}% reduction)`)

    return compressed
  } catch (error) {
    console.error('Compression failed:', error)
    // Compression is required - we cannot upload uncompressed files
    throw new Error('Image compression failed. Please try a different image or reduce its size manually.')
  }
}

/**
 * Validate file before upload
 */
function validateFile(file: File): { valid: boolean; error?: string } {
  // Check file type
  const isAllowedType = ALLOWED_TYPES.includes(file.type) ||
                       file.name.toLowerCase().endsWith('.heic') ||
                       file.name.toLowerCase().endsWith('.heif')

  if (!isAllowedType) {
    return {
      valid: false,
      error: `File type not supported. Please use: JPEG, PNG, PDF, or HEIC`
    }
  }

  // Check original file size (before compression/conversion)
  const fileSizeMB = file.size / 1024 / 1024
  if (fileSizeMB > MAX_ORIGINAL_FILE_SIZE_MB) {
    return {
      valid: false,
      error: `File too large (${fileSizeMB.toFixed(1)}MB). Maximum file size: ${MAX_ORIGINAL_FILE_SIZE_MB}MB.\n\nTip: Modern phone photos can be 10MB+. Try:\n1. Taking a screenshot instead\n2. Using your phone's "optimize" or "reduce size" feature\n3. Using an online image compressor first`
    }
  }

  return { valid: true }
}

/**
 * Upload receipt to Supabase Storage
 *
 * @param file - File to upload (will be converted/compressed automatically)
 * @param userId - User ID (for organizing files)
 * @param expenseId - Expense ID (optional, for naming)
 * @returns Upload result with URL and path
 */
export async function uploadReceipt(
  file: File,
  userId: string,
  expenseId?: string
): Promise<UploadResult> {
  // Validate file
  const validation = validateFile(file)
  if (!validation.valid) {
    throw new Error(validation.error)
  }

  try {
    // Step 1: Convert HEIC to JPEG if needed
    let processedFile = await convertHeicToJpeg(file)

    // Step 2: Compress image
    processedFile = await compressImage(processedFile)

    // Step 3: Check final size
    const finalSizeMB = processedFile.size / 1024 / 1024
    if (finalSizeMB > MAX_FILE_SIZE_MB) {
      throw new Error(`File still too large after compression (${finalSizeMB.toFixed(1)}MB). Maximum: ${MAX_FILE_SIZE_MB}MB`)
    }

    // Step 4: Generate unique filename
    const timestamp = Date.now()
    const randomStr = Math.random().toString(36).substring(7)
    const extension = processedFile.name.split('.').pop() || 'jpg'
    const fileName = expenseId
      ? `${expenseId}_${timestamp}_${randomStr}.${extension}`
      : `receipt_${timestamp}_${randomStr}.${extension}`

    // Step 5: Upload to Supabase Storage
    // Path: userId/fileName (for RLS policies)
    const filePath = `${userId}/${fileName}`

    console.log('Uploading to Supabase Storage:', filePath)

    const { data, error } = await supabase.storage
      .from('receipts')
      .upload(filePath, processedFile, {
        cacheControl: '3600',
        upsert: false
      })

    if (error) {
      console.error('Upload error:', error)
      throw new Error(`Upload failed: ${error.message}`)
    }

    // Step 6: Get public URL
    const { data: urlData } = supabase.storage
      .from('receipts')
      .getPublicUrl(data.path)

    return {
      url: urlData.publicUrl,
      path: data.path,
      size: processedFile.size
    }
  } catch (error: any) {
    console.error('Receipt upload failed:', error)
    throw error
  }
}

/**
 * Delete receipt from Supabase Storage
 */
export async function deleteReceipt(path: string): Promise<void> {
  const { error } = await supabase.storage
    .from('receipts')
    .remove([path])

  if (error) {
    console.error('Delete error:', error)
    throw new Error(`Failed to delete receipt: ${error.message}`)
  }
}

/**
 * Get receipt URL from path
 * Since the bucket is private, we use signed URLs that expire after 1 hour
 */
export async function getReceiptUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from('receipts')
    .createSignedUrl(path, 3600) // 1 hour expiry

  if (error) {
    console.error('Error creating signed URL:', error)
    throw new Error('Failed to get receipt URL')
  }

  return data.signedUrl
}
