import { useCallback, useEffect, useRef, useState } from 'react'
import {
  parseServerReply,
  startPosting,
  stateFromHttpFailure,
  stateFromReply,
  type PageState,
} from './confirmPaymentState'

const FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/payment-confirm`

type Action = 'peek' | 'confirm' | 'not_received'

/** Every call is a POST with the token in the JSON body: it never appears in a URL (so not in request logs). */
export function buildConfirmRequest(token: string, action: Action): RequestInit {
  return {
    method: 'POST',
    headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string, 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: token, action }),
    referrerPolicy: 'no-referrer',
  }
}

/**
 * Talks to the public `payment-confirm` function. The token is the
 * credential: 'peek' only describes the payment, 'confirm' / 'not_received'
 * are the only calls that change anything and they are sent from an explicit
 * button press.
 */
export function useConfirmPayment(token: string | null) {
  const [state, setState] = useState<PageState>(token ? { kind: 'loading' } : { kind: 'dead', reason: 'invalid', payment: null })
  const posting = useRef(false)

  const load = useCallback(async () => {
    if (!token) return
    setState({ kind: 'loading' })
    try {
      const res = await fetch(FUNCTION_URL, buildConfirmRequest(token, 'peek'))
      if (!res.ok) return setState(stateFromHttpFailure(res.status, 'load'))
      setState(stateFromReply(parseServerReply(await res.json())))
    } catch {
      setState(stateFromHttpFailure(null, 'load'))
    }
  }, [token])

  useEffect(() => {
    void load()
  }, [load])

  const send = useCallback(
    async (action: 'confirm' | 'not_received') => {
      if (!token || posting.current) return
      posting.current = true
      let before: PageState | null = null
      setState((s) => {
        before = s
        return startPosting(s, action)
      })
      try {
        const res = await fetch(FUNCTION_URL, buildConfirmRequest(token, action))
        if (!res.ok) {
          const failed = stateFromHttpFailure(res.status, 'post')
          // Keep the buttons usable after a plain failure so the person can try again.
          setState(failed.kind === 'error' && before && (before as PageState).kind === 'valid' ? { ...(before as PageState & { kind: 'valid' }), posting: null } : failed)
          return
        }
        setState(stateFromReply(parseServerReply(await res.json())))
      } catch {
        setState(before && (before as PageState).kind === 'valid' ? { ...(before as PageState & { kind: 'valid' }), posting: null } : stateFromHttpFailure(null, 'post'))
      } finally {
        posting.current = false
      }
    },
    [token]
  )

  return { state, reload: load, confirm: () => send('confirm'), notReceived: () => send('not_received') }
}
