import { describe, it, expect } from 'vitest'
import { applyNoReferrer, captureToken, cleanConfirmPath, ANSWER_STORAGE_KEY, TOKEN_STORAGE_KEY } from './paymentTokenStore'

function memoryStore(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) }
}

describe('captureToken', () => {
  it('takes the token from the URL and remembers it for a refresh', () => {
    const store = memoryStore()
    expect(captureToken('?t=abc', store)).toEqual({ token: 'abc', answer: null, fromUrl: true })
    expect(store.data[TOKEN_STORAGE_KEY]).toBe('abc')
  })
  it('after the URL is cleaned, a refresh uses the remembered token', () => {
    expect(captureToken('', memoryStore({ [TOKEN_STORAGE_KEY]: 'abc' }))).toEqual({ token: 'abc', answer: null, fromUrl: false })
  })
  it('the URL wins over a stale remembered token', () => {
    const store = memoryStore({ [TOKEN_STORAGE_KEY]: 'old' })
    expect(captureToken('?t=new', store).token).toBe('new')
    expect(store.data[TOKEN_STORAGE_KEY]).toBe('new')
  })
  it('no token anywhere is null; a missing or throwing storage is fine', () => {
    expect(captureToken('', memoryStore()).token).toBeNull()
    expect(captureToken('?t=abc', null)).toEqual({ token: 'abc', answer: null, fromUrl: true })
    const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(captureToken('?t=abc', throwing).token).toBe('abc')
    expect(captureToken('', throwing).token).toBeNull()
  })
})

describe('cleanConfirmPath', () => {
  it('keeps the base path and drops the query', () => {
    expect(cleanConfirmPath('/')).toBe('/confirm-payment')
    expect(cleanConfirmPath('/trips/')).toBe('/trips/confirm-payment')
  })
})

describe('applyNoReferrer', () => {
  it('adds a no-referrer meta tag and removes it on cleanup', () => {
    const added: Array<Record<string, string>> = []
    const doc = {
      createElement: () => {
        const attrs: Record<string, string> = {}
        return Object.assign({ name: '', content: '' }, { setAttribute: (k: string, v: string) => void (attrs[k] = v), attrs })
      },
      head: {
        appendChild: (m: { name: string; content: string }) => void added.push({ name: m.name, content: m.content }),
        querySelectorAll: () => ({ forEach: (f: (m: { remove: () => void }) => void) => f({ remove: () => void added.pop() }) }),
      },
    } as unknown as Document
    const undo = applyNoReferrer(doc)
    expect(added).toEqual([{ name: 'referrer', content: 'no-referrer' }])
    undo()
    expect(added).toEqual([])
  })
})

describe('answer hint capture', () => {
  it('takes a=yes|no from the URL and keeps it for a refresh', () => {
    const store = memoryStore()
    expect(captureToken('?t=abc&a=no', store)).toEqual({ token: 'abc', answer: 'no', fromUrl: true })
    expect(store.data[ANSWER_STORAGE_KEY]).toBe('no')
    expect(captureToken('', store)).toEqual({ token: 'abc', answer: 'no', fromUrl: false })
  })
  it('junk or missing a is no hint, and a new link without a clears an old one', () => {
    const store = memoryStore({ [ANSWER_STORAGE_KEY]: 'yes' })
    expect(captureToken('?t=abc&a=maybe', store).answer).toBeNull()
    expect(captureToken('?t=abc', memoryStore({ [ANSWER_STORAGE_KEY]: 'yes' })).answer).toBeNull()
    expect(captureToken('', memoryStore({ [TOKEN_STORAGE_KEY]: 'abc', [ANSWER_STORAGE_KEY]: 'zzz' })).answer).toBeNull()
  })
  it('a stray a= with no token still asks for the address bar to be cleaned', () => {
    expect(captureToken('?a=yes', memoryStore())).toEqual({ token: null, answer: null, fromUrl: true })
  })
})
