import { describe, expect, it } from 'vitest'
import { TOAST_ANIMATION_CLASSES, TOAST_CONTAINER_CLASSES } from './toastLayout'

describe('toast layout', () => {
  it('anchors to the top on phones, respecting the safe area, and bottom-right from sm', () => {
    expect(TOAST_CONTAINER_CLASSES).toContain('top-[calc(env(safe-area-inset-top)+0.75rem)]')
    expect(TOAST_CONTAINER_CLASSES).toContain('sm:bottom-4')
    expect(TOAST_CONTAINER_CLASSES).toContain('sm:top-auto')
    expect(TOAST_CONTAINER_CLASSES).not.toMatch(/(^|\s)bottom-4/)
  })

  it('animates from the top on phones only', () => {
    expect(TOAST_ANIMATION_CLASSES).toContain('fable-toast-in-top')
    expect(TOAST_ANIMATION_CLASSES).toContain('sm:animate-[fable-toast-in')
  })
})
