import { describe, it, expect } from 'vitest'
import { buildConfirmRequest } from './useConfirmPayment'

describe('buildConfirmRequest', () => {
  it('always POSTs the token in the body, never in a URL', () => {
    for (const action of ['peek', 'confirm', 'not_received'] as const) {
      const req = buildConfirmRequest('tok123', action)
      expect(req.method).toBe('POST')
      expect(JSON.parse(req.body as string)).toEqual({ t: 'tok123', action })
      expect(req.referrerPolicy).toBe('no-referrer')
    }
  })
})
