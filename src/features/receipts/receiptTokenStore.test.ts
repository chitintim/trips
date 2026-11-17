import { describe, it, expect } from 'vitest'
import { captureToken, cleanReceiptPath, forgetHint, hintFromSearch, HINT_STORAGE_KEY, TOKEN_STORAGE_KEY } from './receiptTokenStore'

const memory = () => {
  const m = new Map<string, string>()
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

describe('receipt token capture', () => {
  it('takes the token and the hint from the link and remembers them for a refresh', () => {
    const store = memory()
    expect(captureToken('?t=abc&a=done', store)).toEqual({ token: 'abc', hint: 'done', fromUrl: true })
    expect(store.m.get(TOKEN_STORAGE_KEY)).toBe('abc')
    expect(captureToken('', store)).toEqual({ token: 'abc', hint: 'done', fromUrl: false })
  })
  it('accepts the token in the hash (preferred) as well as the query', () => {
    const store = memory()
    expect(captureToken('', store, '#t=abc&a=not_there')).toEqual({ token: 'abc', hint: 'not_there', fromUrl: true })
    expect(captureToken('?t=old', memory(), '#t=new')).toMatchObject({ token: 'new' })
    expect(captureToken('?t=old&a=done', memory(), '')).toMatchObject({ token: 'old', hint: 'done' })
    expect(captureToken('', memory(), '#unrelated')).toEqual({ token: null, hint: null, fromUrl: false })
  })
  it('only done and not_there count as hints', () => {
    expect(hintFromSearch('?a=not_there')).toBe('not_there')
    expect(hintFromSearch('?a=yes')).toBeNull()
    expect(hintFromSearch('?a=DONE')).toBeNull()
  })
  it('works without storage and with no token', () => {
    expect(captureToken('?t=abc', null)).toEqual({ token: 'abc', hint: null, fromUrl: true })
    expect(captureToken('', memory())).toEqual({ token: null, hint: null, fromUrl: false })
  })
  it('forgets the hint once the person has acted', () => {
    const store = memory()
    captureToken('?t=abc&a=done', store)
    forgetHint(store)
    expect(store.m.get(HINT_STORAGE_KEY)).toBe('')
    expect(captureToken('', store).hint).toBeNull()
  })
  it('cleans the address bar to /receipt', () => {
    expect(cleanReceiptPath('/')).toBe('/receipt')
    expect(cleanReceiptPath('/trips/')).toBe('/trips/receipt')
  })
})
