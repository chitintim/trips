/**
 * Confirm-by-email tokens. A token is 32 random bytes, base64url (43 chars, URL
 * safe, so it survives the GitHub Pages 404 redirect). Only its SHA-256 hash
 * (hex) is ever stored; the raw token exists in the email and in the link.
 */

export const TOKEN_LENGTH = 43
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function generateToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

/** Cheap shape check before touching the database (anything else cannot be one of ours). */
export function isPlausibleToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value)
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export const hashToken = sha256Hex
