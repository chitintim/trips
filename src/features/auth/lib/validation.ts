/**
 * Client-side validation shared by every form in src/features/auth/**
 * (Form & Flow Standard: submitting invalid input must show inline,
 * role="alert" error text under the offending field — never a silent
 * no-op). Forms pass `noValidate` and call these explicitly instead of
 * relying on the browser's native constraint-validation UI, which is
 * unreliable on mobile (bubbles can be suppressed entirely in some
 * mobile browsers / installed-PWA contexts — the root cause of the
 * "nothing happens" bug this module fixes).
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Matches ResetPassword's existing client-side check (grepped minLength). */
export const MIN_PASSWORD_LENGTH = 6

export function validateRequired(value: string, label: string): string | null {
  return value.trim() ? null : `${label} is required`
}

export function validateEmail(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return 'Email is required'
  if (!EMAIL_PATTERN.test(trimmed)) return 'Enter a valid email address'
  return null
}

export function validatePassword(value: string, label = 'Password'): string | null {
  if (!value) return `${label} is required`
  if (value.length < MIN_PASSWORD_LENGTH) return `${label} must be at least ${MIN_PASSWORD_LENGTH} characters`
  return null
}
