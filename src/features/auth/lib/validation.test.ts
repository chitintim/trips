import { describe, it, expect } from 'vitest'
import { validateEmail, validatePassword, validateRequired, MIN_PASSWORD_LENGTH } from './validation'

describe('validateRequired', () => {
  it('flags empty and whitespace-only values', () => {
    expect(validateRequired('', 'First name')).toBe('First name is required')
    expect(validateRequired('   ', 'First name')).toBe('First name is required')
  })

  it('accepts non-empty values', () => {
    expect(validateRequired('Ada', 'First name')).toBeNull()
  })
})

describe('validateEmail', () => {
  it('flags empty email', () => {
    expect(validateEmail('')).toBe('Email is required')
    expect(validateEmail('   ')).toBe('Email is required')
  })

  it('flags malformed email', () => {
    expect(validateEmail('not-an-email')).toBe('Enter a valid email address')
    expect(validateEmail('missing@domain')).toBe('Enter a valid email address')
    expect(validateEmail('@nodomain.com')).toBe('Enter a valid email address')
  })

  it('accepts a valid email', () => {
    expect(validateEmail('you@example.com')).toBeNull()
  })
})

describe('validatePassword', () => {
  it('flags empty password', () => {
    expect(validatePassword('')).toBe('Password is required')
  })

  it('flags passwords shorter than the minimum', () => {
    expect(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
    )
  })

  it('accepts a password at or above the minimum, using a custom label', () => {
    expect(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH), 'New password')).toBeNull()
  })
})
