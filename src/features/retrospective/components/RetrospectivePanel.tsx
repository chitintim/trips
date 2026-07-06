import { useEffect, useMemo, useState } from 'react'
import { Button, Card, EmptyState, ProgressBar, Skeleton, StatCard, UserAvatar, useToast } from '../../../components/ui'
import { useTrip, useParticipants } from '../../../lib/queries/useTrip'
import { useExpenses } from '../../../lib/queries/useExpenses'
import { usePlaces } from '../../../lib/queries/usePlaces'
import { getReceiptUrl } from '../../../lib/receiptUpload'
import { PlaceMapThumb } from '../../places'
import { streamChatMessage, ChatQuotaError } from '../../chat'
import { computeTripStats, formatMinor, categoryMeta, buildSummaryText } from '../lib/tripStats'

export interface RetrospectivePanelProps {
  tripId: string
}

const RECAP_PROMPT =
  'Write a warm, fun 5-line recap of this trip for the group to look back on. ' +
  'Use the itinerary and expenses tools to ground it in what actually happened (places, highlights, spending vibe). ' +
  'No headings, no bullet points — just a short paragraph. Do not propose any changes.'

/**
 * Trip retrospective (plan §15): the payoff screen for trip_completed
 * trips — trip in numbers, places-visited mini map, receipts gallery,
 * superlatives, optional AI recap, and a copyable text summary. Everything
 * is computed client-side from data v2 already collects.
 */
export function RetrospectivePanel({ tripId }: RetrospectivePanelProps) {
  const { showToast } = useToast()
  const { data: trip, isLoading: tripLoading } = useTrip(tripId)
  const { data: expensesData, isLoading: expensesLoading } = useExpenses(tripId)
  const { data: participants } = useParticipants(tripId)
  const { data: places } = usePlaces(tripId)

  const baseCurrency = trip?.base_currency || 'GBP'
  const stats = useMemo(
    () => computeTripStats(expensesData?.expenses ?? [], baseCurrency),
    [expensesData, baseCurrency]
  )

  const namesById = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of participants ?? []) {
      map.set(p.user_id, (p.user?.full_name || p.user?.email || 'Someone').split(' ')[0])
    }
    return map
  }, [participants])
  const avatarsById = useMemo(() => {
    const map = new Map<string, unknown>()
    for (const p of participants ?? []) map.set(p.user_id, p.user?.avatar_data ?? null)
    return map
  }, [participants])

  // ---- Receipts gallery (signed URLs, private bucket) --------------------
  const receiptPaths = useMemo(
    () => (expensesData?.expenses ?? []).filter((e) => e.receipt_url).map((e) => ({ id: e.id, path: e.receipt_url as string, label: e.description })),
    [expensesData]
  )
  const [receiptUrls, setReceiptUrls] = useState<Array<{ id: string; url: string; label: string }>>([])
  useEffect(() => {
    let cancelled = false
    Promise.all(
      receiptPaths.slice(0, 12).map(async ({ id, path, label }) => {
        try {
          return { id, url: await getReceiptUrl(path), label }
        } catch {
          return null
        }
      })
    ).then((urls) => {
      if (!cancelled) setReceiptUrls(urls.filter((u): u is { id: string; url: string; label: string } => !!u))
    })
    return () => {
      cancelled = true
    }
  }, [receiptPaths])

  // ---- AI recap (graceful skip on quota/unavailability) ------------------
  const recapCacheKey = `retro-recap:${tripId}`
  const [recap, setRecap] = useState<string | null>(() => {
    try {
      return window.sessionStorage.getItem(recapCacheKey)
    } catch {
      return null
    }
  })
  const [recapLoading, setRecapLoading] = useState(false)
  const [recapNote, setRecapNote] = useState<string | null>(null)

  const generateRecap = async () => {
    setRecapLoading(true)
    setRecapNote(null)
    let text = ''
    try {
      await streamChatMessage(tripId, RECAP_PROMPT, {
        onText: (delta) => {
          text += delta
          setRecap(text)
        },
        onProposal: () => undefined,
        onDone: (message) => {
          const final = message || text
          setRecap(final)
          try {
            window.sessionStorage.setItem(recapCacheKey, final)
          } catch {
            /* cache is best-effort */
          }
        },
        onError: () => setRecapNote('The AI recap is unavailable right now — the numbers below still tell the story.'),
      })
    } catch (err) {
      setRecap(null)
      setRecapNote(
        err instanceof ChatQuotaError
          ? 'Daily AI quota reached — try the recap again tomorrow.'
          : 'The AI recap is unavailable right now — the numbers below still tell the story.'
      )
    } finally {
      setRecapLoading(false)
    }
  }

  const handleCopySummary = async () => {
    if (!trip) return
    try {
      await navigator.clipboard.writeText(buildSummaryText(trip.name, stats, namesById) + (recap ? `\n\n${recap}` : ''))
      showToast({ type: 'success', message: 'Summary copied', description: 'Paste it into the group chat.' })
    } catch {
      showToast({ type: 'error', message: 'Could not copy to clipboard' })
    }
  }

  if (tripLoading || expensesLoading) {
    return (
      <div className="space-y-4">
        <Skeleton variant="card" height={90} />
        <Skeleton variant="card" height={160} />
      </div>
    )
  }
  if (!trip) return null

  const pinnedPlaces = (places ?? []).filter((p) => p.lat != null && p.lng != null)
  const perHead = stats.byPerson.length > 0 ? Math.round(stats.totalMinor / stats.byPerson.length) : 0
  const maxDay = Math.max(1, ...stats.byDay.map((d) => d.amountMinor))
  const maxCategory = Math.max(1, ...stats.byCategory.map((c) => c.amountMinor))
  const s = stats.superlatives

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-[var(--text-primary)]">🎉 {trip.name} — the recap</h2>
          <p className="text-sm text-[var(--text-secondary)]">
            {trip.start_date} → {trip.end_date} · {trip.location}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={handleCopySummary}>
          📋 Copy summary text
        </Button>
      </div>

      {/* ---- AI recap ---------------------------------------------------- */}
      <Card variant="flat">
        <Card.Content>
          {recap ? (
            <p className="text-sm leading-relaxed text-[var(--text-primary)] whitespace-pre-wrap">✨ {recap}</p>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-[var(--text-secondary)]">Want a five-line story of the trip, written from the itinerary and receipts?</p>
              <Button size="sm" onClick={generateRecap} isLoading={recapLoading}>
                ✨ Write the recap
              </Button>
            </div>
          )}
          {recapNote && <p className="mt-2 text-xs text-[var(--text-muted)]">{recapNote}</p>}
        </Card.Content>
      </Card>

      {/* ---- Trip in numbers --------------------------------------------- */}
      {stats.expenseCount === 0 ? (
        <EmptyState icon="🧾" title="No expenses recorded" description="Numbers show up here once the trip has some spending history." compact />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Total spent" value={formatMinor(stats.totalMinor, baseCurrency)} icon={<span>💷</span>} />
            <StatCard label="Per payer" value={formatMinor(perHead, baseCurrency)} icon={<span>👤</span>} />
            <StatCard label="Expenses" value={String(stats.expenseCount)} icon={<span>🧾</span>} />
            <StatCard label="Days with spending" value={String(stats.byDay.length)} icon={<span>📅</span>} />
          </div>
          {stats.skippedCount > 0 && (
            <p className="text-xs text-[var(--text-muted)]">
              {stats.skippedCount} foreign-currency expense{stats.skippedCount === 1 ? '' : 's'} without a locked FX rate excluded from totals.
            </p>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <Card.Content>
                <h3 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">By category</h3>
                <div className="space-y-2.5">
                  {stats.byCategory.map((c) => {
                    const meta = categoryMeta(c.category)
                    return (
                      <div key={c.category}>
                        <div className="mb-1 flex items-center justify-between text-sm">
                          <span className="text-[var(--text-primary)]">
                            {meta.icon} {meta.label}
                          </span>
                          <span className="font-medium text-[var(--text-secondary)]">{formatMinor(c.amountMinor, baseCurrency)}</span>
                        </div>
                        <ProgressBar value={c.amountMinor} max={maxCategory} size="sm" variant="accent" />
                      </div>
                    )
                  })}
                </div>
              </Card.Content>
            </Card>

            <Card>
              <Card.Content>
                <h3 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">Who paid</h3>
                <ul className="space-y-2">
                  {stats.byPerson.map((p) => (
                    <li key={p.userId} className="flex items-center gap-2.5">
                      <UserAvatar avatarData={avatarsById.get(p.userId)} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">
                        {namesById.get(p.userId) ?? 'Someone'}
                      </span>
                      <span className="text-sm font-medium text-[var(--text-secondary)]">{formatMinor(p.amountMinor, baseCurrency)}</span>
                    </li>
                  ))}
                </ul>
              </Card.Content>
            </Card>
          </div>

          {stats.byDay.length > 1 && (
            <Card>
              <Card.Content>
                <h3 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">Spend per day</h3>
                <div className="flex items-end gap-1.5 overflow-x-auto pb-1" style={{ height: 96 }}>
                  {stats.byDay.map((d) => (
                    <div key={d.date} className="flex min-w-8 flex-1 flex-col items-center justify-end gap-1 self-stretch" title={`${d.date}: ${formatMinor(d.amountMinor, baseCurrency)}`}>
                      <div
                        className="w-full rounded-t bg-accent-500"
                        style={{ height: `${Math.max(4, Math.round((d.amountMinor / maxDay) * 70))}px` }}
                      />
                      <span className="text-[0.625rem] text-[var(--text-muted)]">{d.date.slice(8, 10)}</span>
                    </div>
                  ))}
                </div>
              </Card.Content>
            </Card>
          )}

          {/* ---- Superlatives ---------------------------------------------- */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {s.mostExpensiveMeal && (
              <StatCard label="Most expensive meal" value={formatMinor(s.mostExpensiveMeal.amountMinor, baseCurrency)} delta={s.mostExpensiveMeal.description} icon={<span>🍽️</span>} />
            )}
            {s.cheapestDay && (
              <StatCard label="Cheapest day" value={formatMinor(s.cheapestDay.amountMinor, baseCurrency)} delta={s.cheapestDay.date} icon={<span>🪙</span>} />
            )}
            {s.biggestPayer && (
              <StatCard
                label="Biggest payer"
                value={namesById.get(s.biggestPayer.userId) ?? 'Someone'}
                delta={formatMinor(s.biggestPayer.amountMinor, baseCurrency)}
                icon={<span>🏆</span>}
              />
            )}
          </div>
        </>
      )}

      {/* ---- Places visited ---------------------------------------------- */}
      {pinnedPlaces.length > 0 && (
        <Card>
          <Card.Content>
            <h3 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">Everywhere you went</h3>
            <div className="flex gap-3 overflow-x-auto pb-1">
              {pinnedPlaces.map((place) => (
                <div key={place.id} className="w-40 shrink-0">
                  <PlaceMapThumb lat={place.lat as number} lng={place.lng as number} height={96} />
                  <p className="mt-1 truncate text-xs text-[var(--text-secondary)]" title={place.name}>
                    📍 {place.name}
                  </p>
                </div>
              ))}
            </div>
          </Card.Content>
        </Card>
      )}

      {/* ---- Receipts gallery --------------------------------------------- */}
      {receiptUrls.length > 0 && (
        <Card>
          <Card.Content>
            <h3 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">Receipts gallery</h3>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
              {receiptUrls.map((r) => (
                <a key={r.id} href={r.url} target="_blank" rel="noopener noreferrer" title={r.label} className="block overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
                  <img src={r.url} alt={`Receipt: ${r.label}`} className="h-24 w-full object-cover transition-transform hover:scale-105" loading="lazy" />
                </a>
              ))}
            </div>
          </Card.Content>
        </Card>
      )}
    </div>
  )
}
