import { Link } from 'react-router-dom'
import { Card } from '../../../components/ui'
import type { ReceiptClaimStatus } from '../lib/balances'
import { NOTICE_MANAGER_LIVE, NOTICE_PAYER_LIVE, NOTICE_TITLE, notClaimedLine } from './unclaimedReceipts'

interface Props {
  receipts: ReceiptClaimStatus[]
  /** People who can manage the trip see the manager wording; a payer sees the payer's. */
  canManageTrip: boolean
  className?: string
}

/** Settle up: receipts with items nobody has claimed (managers see all, payers their own). Links to each claim page. */
export function UnclaimedReceiptsNotice({ receipts, canManageTrip, className }: Props) {
  if (receipts.length === 0) return null
  const advice = canManageTrip ? NOTICE_MANAGER_LIVE : NOTICE_PAYER_LIVE
  return (
    <Card variant="sunken" noPadding className={`p-3.5 space-y-1.5 ${className ?? ''}`} id="unclaimed-receipts">
      <p className="text-sm font-semibold text-[var(--text-primary)]">{NOTICE_TITLE}</p>
      <ul className="space-y-0.5">
        {receipts.map((r) => (
          <li key={r.expenseId} className="text-sm text-[var(--text-secondary)]">
            {r.claimCode ? (
              <Link to={`/claim/${r.claimCode}`} className="font-medium text-accent-700 dark:text-accent-400 underline">
                {notClaimedLine(r)}
              </Link>
            ) : (
              notClaimedLine(r)
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-[var(--text-muted)]" role="status">
        {advice}
      </p>
    </Card>
  )
}
