import { useCallback, useEffect, useRef, useState } from 'react'
import {
  NO_TOKEN_STATE,
  changeHint,
  parseServerReply,
  startPosting,
  stateFromHttpFailure,
  stateFromReply,
  type Action,
  type Hint,
  type PageState,
} from './receiptClaimState'

const FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/receipt-claim`

type Request = { action: 'peek' } | { action: Action; lineItemId?: string; on?: boolean }

/** Every call is a POST with the token in the JSON body: it never appears in a URL (so not in request logs). */
export function buildReceiptRequest(token: string, req: Request): RequestInit {
  const body: Record<string, unknown> = { t: token, action: req.action }
  if ('lineItemId' in req && req.lineItemId) body.line_item_id = req.lineItemId
  if ('on' in req && typeof req.on === 'boolean') body.on = req.on
  return {
    method: 'POST',
    headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    referrerPolicy: 'no-referrer',
  }
}

/**
 * Talks to the public `receipt-claim` function. 'peek' only describes the receipt; the other actions change
 * things and are only ever sent from a button press (the `a=` hint in the link merely pre-selects a button).
 */
export function useReceiptClaim(token: string | null, hint: Hint | null = null, onActed?: () => void) {
  const [state, setState] = useState<PageState>(token ? { kind: 'loading' } : NO_TOKEN_STATE)
  const posting = useRef(false)

  const load = useCallback(async () => {
    if (!token) return
    setState({ kind: 'loading' })
    try {
      const res = await fetch(FUNCTION_URL, buildReceiptRequest(token, { action: 'peek' }))
      if (!res.ok) return setState(stateFromHttpFailure(res.status))
      setState(stateFromReply(parseServerReply(await res.json()), hint))
    } catch {
      setState(stateFromHttpFailure(null))
    }
  }, [token, hint])

  useEffect(() => {
    void load()
  }, [load])

  const send = useCallback(
    async (req: Exclude<Request, { action: 'peek' }>) => {
      if (!token || posting.current) return
      posting.current = true
      let before: PageState | null = null
      setState((s) => {
        before = s
        return startPosting(s, req.action)
      })
      const keep = () => setState(before && (before as PageState).kind === 'ready' ? { ...(before as PageState & { kind: 'ready' }), posting: null, notice: 'That did not go through. Try again.' } : stateFromHttpFailure(null))
      try {
        const res = await fetch(FUNCTION_URL, buildReceiptRequest(token, req))
        if (!res.ok) {
          const failed = stateFromHttpFailure(res.status)
          if (failed.kind === 'error') keep()
          else setState(failed)
          return
        }
        setState(stateFromReply(parseServerReply(await res.json()), null))
        onActed?.()
      } catch {
        keep()
      } finally {
        posting.current = false
      }
    },
    [token, onActed]
  )

  return {
    state,
    reload: load,
    changeHint: () => setState((s) => changeHint(s)),
    done: () => send({ action: 'done' }),
    notThere: () => send({ action: 'not_there' }),
    undo: () => send({ action: 'undo_done' }),
    toggle: (lineItemId: string, on: boolean) => send({ action: 'toggle', lineItemId, on }),
  }
}
