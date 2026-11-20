import { describe, expect, it } from 'vitest'
import { DATE_LIKE_INPUT_CLASSES, INPUT_WRAPPER_CLASSES, isDateLikeType } from './inputClasses'

describe('inputClasses', () => {
  it('treats native date and time pickers as date-like', () => {
    for (const t of ['date', 'time', 'datetime-local', 'month']) {
      expect(isDateLikeType(t)).toBe(true)
    }
  })

  it('leaves text-like inputs alone', () => {
    for (const t of ['text', 'email', 'number', 'password', undefined]) {
      expect(isDateLikeType(t)).toBe(false)
    }
  })

  it('lets date inputs and their wrapper shrink inside a grid column', () => {
    expect(DATE_LIKE_INPUT_CLASSES).toContain('min-w-0')
    expect(DATE_LIKE_INPUT_CLASSES).toContain('max-w-full')
    expect(INPUT_WRAPPER_CLASSES).toContain('min-w-0')
  })
})
