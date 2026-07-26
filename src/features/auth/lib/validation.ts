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

/**
 * Confirm-email match check for signup (2026-07-26 typo'd-email incident --
 * a user signed up with a missing letter in their email, never got the
 * confirmation email, and was permanently locked out with no recovery
 * path). Compares case-insensitively and after trimming, since neither
 * whitespace nor letter-casing makes two email addresses actually
 * different, and mobile keyboards/autocapitalize can introduce exactly
 * that kind of harmless difference. Assumes the primary email has already
 * been format-checked via `validateEmail` -- this only checks the two
 * fields agree.
 */
export function validateEmailConfirmation(email: string, confirmEmail: string): string | null {
  const trimmedConfirm = confirmEmail.trim()
  if (!trimmedConfirm) return 'Please confirm your email'
  if (trimmedConfirm.toLowerCase() !== email.trim().toLowerCase()) return "Emails don't match"
  return null
}

export function validatePassword(value: string, label = 'Password'): string | null {
  if (!value) return `${label} is required`
  if (value.length < MIN_PASSWORD_LENGTH) return `${label} must be at least ${MIN_PASSWORD_LENGTH} characters`
  return null
}
