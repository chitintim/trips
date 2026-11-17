import { Card, Skeleton } from '../../../components/ui'
import { useAiUsage } from '../lib/useAiUsage'
import { cacheShare, formatUsd, groupByDay, groupByFunction, totalsOf } from '../lib/usageSummary'

const num = (v: number) => v.toLocaleString('en-GB')
const th = 'px-2 py-1 text-left font-medium text-[var(--text-secondary)]'
const td = 'px-2 py-1 tabular-nums'

/**
 * Dashboard -> "AI usage" tab. Rendered only for site admins (the Dashboard
 * only shows admin tabs when users.role === 'admin'; the RPC enforces it too).
 */
export function AdminAiUsageTab() {
  const { data, isLoading, isError } = useAiUsage(true)

  if (isLoading) return <Skeleton variant="card" height={160} />
  if (isError) return <p className="text-sm text-[var(--text-secondary)]">Couldn't load usage. Try again in a moment.</p>
  if (!data || data.status === 'unavailable') {
    return <p className="text-sm text-[var(--text-secondary)]">Usage isn't available yet.</p>
  }

  const { usage, actions, days } = data.summary
  const totals = totalsOf(usage)
  const byFn = groupByFunction(usage)
  const byDay = groupByDay(usage)

  return (
    <div className="space-y-6">
      <Card>
        <h2 className="text-base font-semibold text-[var(--text-primary)]">AI usage, last {days} days</h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          {num(totals.calls)} calls, {num(totals.input_tokens)} in / {num(totals.output_tokens)} out tokens, cache read{' '}
          {num(totals.cache_read_tokens)} / write {num(totals.cache_write_tokens)} ({Math.round(cacheShare(totals) * 100)}% from cache),
          estimated {formatUsd(totals.cost_usd)}.
        </p>
      </Card>

      <section className="overflow-x-auto">
        <h3 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">By function</h3>
        <table className="w-full text-sm">
          <thead>
            <tr>
              {['Function', 'Model', 'Calls', 'Input', 'Output', 'Cache read', 'Cache write', 'Est. cost'].map((h) => (
                <th key={h} className={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {byFn.map((r) => (
              <tr key={r.function_name + r.model} className="border-t border-[var(--border-subtle)]">
                <td className={td}>{r.function_name}</td>
                <td className={td}>{r.model}</td>
                <td className={td}>{num(r.calls)}</td>
                <td className={td}>{num(r.input_tokens)}</td>
                <td className={td}>{num(r.output_tokens)}</td>
                <td className={td}>{num(r.cache_read_tokens)}</td>
                <td className={td}>{num(r.cache_write_tokens)}</td>
                <td className={td}>{formatUsd(r.cost_usd)}</td>
              </tr>
            ))}
            {byFn.length === 0 && (
              <tr>
                <td className={td} colSpan={8}>No calls in this period.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="overflow-x-auto">
        <h3 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">By day</h3>
        <table className="w-full text-sm">
          <thead>
            <tr>
              {['Day', 'Calls', 'Input', 'Output', 'Cache read', 'Cache write', 'Est. cost'].map((h) => (
                <th key={h} className={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {byDay.map((r) => (
              <tr key={r.day} className="border-t border-[var(--border-subtle)]">
                <td className={td}>{r.day}</td>
                <td className={td}>{num(r.calls)}</td>
                <td className={td}>{num(r.input_tokens)}</td>
                <td className={td}>{num(r.output_tokens)}</td>
                <td className={td}>{num(r.cache_read_tokens)}</td>
                <td className={td}>{num(r.cache_write_tokens)}</td>
                <td className={td}>{formatUsd(r.cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {actions.length > 0 && (
        <section className="overflow-x-auto">
          <h3 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">Assistant actions (errors = failed)</h3>
          <table className="w-full text-sm">
            <thead>
              <tr>
                {['Kind', 'Proposed', 'Started', 'Done', 'Failed', 'Dismissed', 'Expired', 'Edited'].map((h) => (
                  <th key={h} className={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {actions.map((a) => (
                <tr key={a.kind} className="border-t border-[var(--border-subtle)]">
                  <td className={td}>{a.kind}</td>
                  <td className={td}>{a.proposed}</td>
                  <td className={td}>{a.started}</td>
                  <td className={td}>{a.done}</td>
                  <td className={td}>{a.failed}</td>
                  <td className={td}>{a.dismissed}</td>
                  <td className={td}>{a.expired}</td>
                  <td className={td}>{a.edited}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}
