import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Card, Skeleton } from '../../components/ui'
import { formatMoney } from '../../lib/money/format'
import { applyNoReferrer, safeSessionStorage } from '../payments/paymentTokenStore'
import { COPY, screenOf, shareLabel, type PageState, type ReceiptView } from './receiptClaimState'
import { captureToken, cleanReceiptPath, forgetHint } from './receiptTokenStore'
import { formatDeadlineDay, LEFTOVER_RULE, replyByLine } from './receiptFormat'
import { useReceiptClaim } from './useReceiptClaim'

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-[var(--surface-page)] flex items-center justify-center p-4">
      <Card className="max-w-md w-full">
        <Card.Content className="py-8 space-y-4">{children}</Card.Content>
      </Card>
    </main>
  )
}

const LINK_CLASS = 'inline-block text-sm font-medium text-accent-700 dark:text-accent-400 underline'

function OpenApp({ receipt }: { receipt: ReceiptView | null }) {
  return receipt ? (
    <Link to={`/${receipt.tripId}?open=claim:${receipt.expenseId}`} className={LINK_CLASS}>
      {COPY.openApp}
    </Link>
  ) : (
    <Link to="/" className={LINK_CLASS}>
      {COPY.openAppGeneric}
    </Link>
  )
}

/** What the page does when a person taps. Nothing here runs on load. */
export interface ReceiptActions {
  reload: () => void
  changeHint: () => void
  done: () => void
  notThere: () => void
  undo: () => void
  toggle: (lineItemId: string, on: boolean) => void
}

/**
 * PUBLIC page behind the personal link in the "tell us what you had" email (/receipt#t=<token>, or the older ?t=<token>).
 * The token is the credential, so no sign-in is needed. Opening the page changes nothing: only the buttons do,
 * and `a=done` / `a=not_there` in the link merely pre-selects which button is shown first.
 */
export function ReceiptClaimPage() {
  const [{ token, hint, fromUrl }] = useState(() => captureToken(window.location.search, safeSessionStorage(), window.location.hash))
  useEffect(() => {
    if (fromUrl) window.history.replaceState(window.history.state, '', cleanReceiptPath(import.meta.env.BASE_URL))
  }, [fromUrl])
  useEffect(() => applyNoReferrer(document), [])
  const { state, ...actions } = useReceiptClaim(token, hint, () => forgetHint(safeSessionStorage()))
  return <ReceiptClaimView state={state} api={actions} />
}

/** The page for a given state (pure of I/O, so it can be rendered in tests). */
export function ReceiptClaimView({ state, api }: { state: PageState; api: ReceiptActions }) {
  if (state.kind === 'loading') {
    return (
      <Shell>
        <p className="sr-only" role="status">
          {COPY.loading}
        </p>
        <Skeleton variant="text" lines={3} />
        <Skeleton variant="card" height={44} />
      </Shell>
    )
  }

  if (state.kind === 'dead' || state.kind === 'unavailable') {
    const text = state.kind === 'unavailable' ? COPY.unavailable : state.reason === 'no_token' ? COPY.noToken : COPY[state.reason]
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-[var(--text-primary)]" role="status">
          {text}
        </h1>
        <OpenApp receipt={null} />
      </Shell>
    )
  }

  if (state.kind === 'rate_limited' || state.kind === 'error') {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-[var(--text-primary)]" role="alert">
          {state.kind === 'rate_limited' ? COPY.rateLimited : COPY.error}
        </h1>
        {state.kind === 'error' && (
          <Button variant="secondary" onClick={api.reload}>
            Try again
          </Button>
        )}
      </Shell>
    )
  }

  const { receipt: r, posting, notice } = state
  const busy = posting !== null
  const money = (n: number) => formatMoney(n, r.currency, { mode: 'exact' })
  const screen = screenOf(r)
  const share = money(r.myTotal)
  const showItems = r.onReceipt && screen !== 'not_there'
  const editable = screen === 'open' || screen === 'done'
  const canSayNotThere = !r.meIsPayer
  // The payer is done by definition when they send the receipt: no "That's everything" for them.
  const canSayDone = !r.meIsPayer

  return (
    <Shell>
      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">{COPY.forLine(r.meFirstName)}</p>
        <p className="text-xs text-[var(--text-muted)]">{r.tripName}</p>
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">{COPY.headline(r.payerFirstName, r.title)}</h1>
      </div>

      {notice && (
        <p className="text-sm text-[var(--text-primary)] rounded-[var(--radius-sm)] bg-[var(--surface-sunken)] px-3 py-2" role="alert">
          {notice}
        </p>
      )}

      {screen === 'frozen' && (
        <p className="text-sm text-[var(--text-primary)]" role="status">
          {COPY.frozenLine(share)}
        </p>
      )}
      {screen === 'closed' && (
        <div className="space-y-1" role="status">
          <p className="text-sm font-medium text-[var(--text-primary)]">{COPY.closedLine(share)}</p>
          {r.closedAt && <p className="text-sm text-[var(--text-secondary)]">{COPY.closedOn(formatDeadlineDay(r.closedAt))}</p>}
          {r.myLeftoverTotal > 0 && <p className="text-sm text-[var(--text-secondary)]">{COPY.leftoverNote(money(r.myLeftoverTotal))}</p>}
        </div>
      )}
      {screen === 'read_only' && (
        <p className="text-sm text-[var(--text-primary)]" role="status">
          {COPY.readOnly} {COPY.total}: {share}
        </p>
      )}
      {screen === 'not_there' && (
        <p className="text-sm font-medium text-[var(--text-primary)]" role="status">
          {COPY.notThereThanks(r.payerFirstName)}
        </p>
      )}
      {screen === 'done' && (
        <p className="text-base font-medium text-[var(--text-primary)]" role="status">
          {COPY.doneThanks(share)}
        </p>
      )}

      {editable && r.deadline && (
        <div className="space-y-1">
          <p className="text-sm font-medium text-[var(--text-primary)]">{replyByLine(r.deadline)}</p>
          {screen === 'open' && <p className="text-xs text-[var(--text-muted)]">{LEFTOVER_RULE}</p>}
        </div>
      )}

      {showItems && (
        <section className="space-y-2" aria-label="Your items">
          {r.myItems.length > 0 ? (
            <>
              <p className="text-sm text-[var(--text-secondary)]">{editable && !r.meIsPayer ? COPY.putDown(r.payerFirstName) : COPY.ownItems}</p>
              <ul className="space-y-1">
                {r.myItems.map((it) => (
                  <li key={it.lineItemId} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 break-words text-[var(--text-primary)]">
                      {it.name}
                      {shareLabel(it) && <span className="ml-1 text-xs font-medium text-accent-700 dark:text-accent-400">{shareLabel(it)}</span>}
                    </span>
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="tabular-nums text-[var(--text-primary)]">{money(it.myAmount)}</span>
                      {editable && it.canToggle && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => api.toggle(it.lineItemId, false)}
                          className="min-h-11 px-2 text-sm font-medium text-accent-700 dark:text-accent-400 disabled:opacity-50"
                          aria-label={`${COPY.notYours}: ${it.name}`}
                        >
                          {COPY.notYours}
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="flex items-baseline justify-between text-sm font-semibold text-[var(--text-primary)] border-t border-[var(--border-subtle)] pt-2">
                <span>{COPY.total}</span>
                <span className="tabular-nums">{share}</span>
              </p>
            </>
          ) : (
            screen === 'open' && <p className="text-sm text-[var(--text-secondary)]">{COPY.nothingYet}</p>
          )}

          {editable && r.availableItems.length > 0 && (
            <div className="space-y-1 pt-2">
              <p className="text-sm text-[var(--text-secondary)]">{COPY.tickPrompt}</p>
              <ul className="space-y-1">
                {r.availableItems.map((it) => (
                  <li key={it.lineItemId}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={false}
                      disabled={busy}
                      onClick={() => api.toggle(it.lineItemId, true)}
                      className="w-full min-h-11 flex items-center justify-between gap-2 text-left text-sm rounded-[var(--radius-sm)] border border-[var(--border-default)] px-3 py-1.5 disabled:opacity-50"
                    >
                      <span className="min-w-0 break-words text-[var(--text-primary)]">
                        {it.name}
                        {it.others.length > 0 && <span className="block text-xs text-[var(--text-muted)]">with {it.others.join(', ')}</span>}
                      </span>
                      <span className="tabular-nums shrink-0 text-[var(--text-primary)]">{money(it.total)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {screen === 'open' && (
        <div className="space-y-2 pt-2">
          {state.hint === 'not_there' && canSayNotThere ? (
            <>
              <Button fullWidth size="lg" onClick={api.notThere} disabled={busy} isLoading={posting === 'not_there'}>
                {COPY.notThere}
              </Button>
              <button type="button" onClick={api.changeHint} disabled={busy} className="text-sm text-[var(--text-muted)] underline disabled:opacity-50">
                {COPY.notNow}
              </button>
            </>
          ) : (
            <>
              {canSayDone && (
                <Button fullWidth size="lg" onClick={api.done} disabled={busy} isLoading={posting === 'done'}>
                  {COPY.done}
                </Button>
              )}
              {canSayNotThere && (
                <Button fullWidth variant="secondary" onClick={api.notThere} disabled={busy} isLoading={posting === 'not_there'}>
                  {COPY.notThere}
                </Button>
              )}
            </>
          )}
        </div>
      )}

      {(screen === 'done' || screen === 'not_there') && !r.meIsPayer && (
        <div className="pt-1">
          <Button variant="secondary" onClick={api.undo} disabled={busy} isLoading={posting === 'undo_done'}>
            {COPY.undo}
          </Button>
        </div>
      )}

      <OpenApp receipt={r} />
    </Shell>
  )
}
