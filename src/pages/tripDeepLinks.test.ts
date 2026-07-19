import { describe, it, expect } from 'vitest'
import { resolveOpenParam } from './tripDeepLinks'

describe('resolveOpenParam', () => {
  it('resolves "travel-details" to the travel-details sheet', () => {
    expect(resolveOpenParam('travel-details')).toEqual({ kind: 'travel-details' })
  })

  it('resolves "actions" to the actions sheet on the actions segment', () => {
    expect(resolveOpenParam('actions')).toEqual({ kind: 'actions', segment: 'actions' })
  })

  it('resolves "actions-bring" to the actions sheet on the bring segment', () => {
    expect(resolveOpenParam('actions-bring')).toEqual({ kind: 'actions', segment: 'bring' })
  })

  it('returns null for an unrecognized value', () => {
    expect(resolveOpenParam('something-else')).toBeNull()
  })

  it('returns null for null (param absent)', () => {
    expect(resolveOpenParam(null)).toBeNull()
  })
})
