import { describe, expect, it } from 'vitest'
import { resyncSelections } from './claimSelections'

describe('resyncSelections', () => {
  it('follows the server for lines the person has not touched', () => {
    expect(resyncSelections({ a: 1 }, { a: 1 }, { a: 1, b: 2 })).toEqual({ a: 1, b: 2 })
  })
  it('drops lines the server no longer has', () => {
    expect(resyncSelections({ a: 1 }, { a: 1 }, {})).toEqual({})
  })
  it('keeps unsaved edits', () => {
    expect(resyncSelections({ a: 3 }, { a: 1 }, { a: 1, b: 2 })).toEqual({ a: 3, b: 2 })
  })
  it('keeps an unsaved removal', () => {
    expect(resyncSelections({ a: 0 }, { a: 1 }, { a: 1 })).toEqual({ a: 0 })
  })
})
