import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Card, Skeleton } from '../../components/ui'
import { COPY, type PaymentSummary } from './confirmPaymentState'
import { useConfirmPayment } from './useConfirmPayment'
import { applyNoReferrer, captureToken, cleanConfirmPath, safeSessionStorage } from './paymentTokenStore'

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-[var(--surface-page)] flex items-center justify-center p-4">
      <Card className="max-w-md w-full">
        <Card.Content className="py-8 space-y-4 text-center">{children}</Card.Content>
      </Card>
    </main>
  )
}

function OpenTrip({ payment }: { payment: PaymentSummary | null }) {
  return payment ? (
    <Link to={`/${payment.tripId}`} className="inline-block">
      <Button variant="secondary">{COPY.openTrip(payment.tripName)}</Button>
    </Link>
  ) : (
    <Link to="/" className="inline-block">
      <Button variant="secondary">Open Tim's Trip Planner</Button>
    </Link>
  )
}

/**
 * PUBLIC page behind the "Yes, I received it" button in the payment email
 * (/confirm-payment?t=<token>). The token is the credential, so no sign-in is
 * needed. Opening the page changes nothing: only the two buttons do.
 *
 * The token is taken out of the address bar on load: kept in memory (and in
 * sessionStorage, this tab only, so a refresh works), the URL is rewritten to
 * /confirm-payment, and the page sends no referrer. Requests carry it in a
 * POST body, never in a URL. (The service worker only handles the share-target
 * POST, so nothing here is cached.)
 */
export function ConfirmPaymentPage() {
  const [{ token, fromUrl }] = useState(() => captureToken(window.location.search, safeSessionStorage()))
  useEffect(() => {
    if (fromUrl) window.history.replaceState(window.history.state, '', cleanConfirmPath(import.meta.env.BASE_URL))
  }, [fromUrl])
  useEffect(() => applyNoReferrer(document), [])
  const { state, reload, confirm, notReceived } = useConfirmPayment(token)

  if (state.kind === 'loading') {
    return (
      <Shell>
        <p className="sr-only" role="status">
          {COPY.loading}
        </p>
        <Skeleton variant="text" lines={2} />
        <Skeleton variant="card" height={44} />
      </Shell>
    )
  }

  if (state.kind === 'valid') {
    const busy = state.posting !== null
    return (
      <Shell>
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">{COPY.forLine(state.payment.receiverName)}</p>
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">{COPY.headline(state.payment)}</h1>
        {state.payment.note && <p className="text-sm text-[var(--text-secondary)]">&ldquo;{state.payment.note}&rdquo;</p>}
        <p className="text-sm text-[var(--text-secondary)]">{COPY.checkFirst}</p>
        <div className="space-y-2 pt-2">
          <Button fullWidth onClick={confirm} disabled={busy} isLoading={state.posting === 'confirm'}>
            Yes, I received it
          </Button>
          <Button fullWidth variant="secondary" onClick={notReceived} disabled={busy} isLoading={state.posting === 'not_received'}>
            I haven't received it
          </Button>
        </div>
      </Shell>
    )
  }

  if (state.kind === 'done') {
    const payer = state.payment?.payerName ?? 'The payer'
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-[var(--text-primary)]" role="status">
          {state.result === 'confirmed' ? COPY.confirmedLine(payer) : COPY.disputedLine(payer)}
        </h1>
        <OpenTrip payment={state.payment} />
      </Shell>
    )
  }

  if (state.kind === 'dead') {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">{COPY[state.reason]}</h1>
        {state.reason !== 'invalid' && <OpenTrip payment={state.payment} />}
        {state.reason === 'invalid' && <OpenTrip payment={null} />}
      </Shell>
    )
  }

  return (
    <Shell>
      <h1 className="text-lg font-semibold text-[var(--text-primary)]" role="alert">
        {state.kind === 'rate_limited' ? COPY.rateLimited : COPY.error}
      </h1>
      {state.kind === 'error' && state.retry === 'load' && (
        <Button variant="secondary" onClick={reload}>
          Try again
        </Button>
      )}
    </Shell>
  )
}
