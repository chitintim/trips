// I/O half of the receipt passes ("receipt reminders" and "apply deadlines"). Injectable client, so tests use a fake.
// NOT gated by chase_settings.enabled (the reminder switch, OFF everywhere): the receipt's own state and
// trips.receipt_notices_enabled govern. Money correctness never depends on email: the "apply deadlines" pass runs with no email
// provider and inside quiet hours. A missing provider holds back EMAILS only. Reminder and result emails are once-only transactional notices from a job that runs once a day, so a trip's quiet hours (chase_settings.quiet_hours) do NOT hold them (otherwise a trip whose quiet hours include the run time would never get them). Result
// emails are recoverable: every run, for receipts closed in the last 7 days, anyone charged a leftover with no `result` notice row
// yet is sent one (dedupe key as before), so a provider failure or a missing provider only delays the email.
import {
  isMissingColumnOrTable,
  isMissingFunction,
  reminderRecipients,
  isPermanentApplyRefusal,
  resultRecoveryRecipients,
  selectApplyCandidates,
  selectRecentlyClosed,
  selectReminderCandidates,
  tableNoticeCutoffIso,
  tableNoticeKeys,
  type ApplyResult,
  type ReceiptRow,
} from './receiptPasses.ts'
import type { AdminClient, ReceiptNoticeSenders } from './receiptSenders.ts'
import { toMinorUnits } from '../_shared/money/minorUnits.ts'
import { decideResultSequence, RECEIPT_RESULT_KIND } from '../_shared/receiptNoticeCore.ts'

export interface ReceiptPassSummary {
  receipt_senders_available: boolean
  receipts_considered: number
  reminder_receipts: number
  reminders_sent: number
  apply_candidates: number
  applied: number
  apply_skipped: number
  result_receipts: number
  result_notices_sent: number
  errors: number
  rpc_missing: boolean
  skipped_reason: string | null
}

export const RECEIPT_SELECT =
  'id, trip_id, paid_by, description, currency, claims_sent_at, claims_closed_at, claim_deadline, trips!inner(name, base_currency, settlement_snapshot, receipt_notices_enabled, chase_settings)'

export async function runReceiptPasses(admin: AdminClient, now: Date, senders: ReceiptNoticeSenders | null): Promise<ReceiptPassSummary> {
  const s: ReceiptPassSummary = {
    receipt_senders_available: !!senders, receipts_considered: 0, reminder_receipts: 0, reminders_sent: 0,
    apply_candidates: 0, applied: 0, apply_skipped: 0, result_receipts: 0, result_notices_sent: 0, errors: 0, rpc_missing: false, skipped_reason: null,
  }
  try {
    const { data, error } = await admin
      .from('expenses').select(RECEIPT_SELECT)
      .not('claims_sent_at', 'is', null).is('claims_closed_at', null).not('claim_deadline', 'is', null)
    if (error) {
      s.skipped_reason = isMissingColumnOrTable(error) ? 'migration_not_applied' : 'query_failed'
      if (s.skipped_reason === 'query_failed') s.errors++
      return s
    }
    const rows = ((data ?? []) as Array<ReceiptRow & { trips: unknown }>).map((r) => ({
      ...r, trips: (Array.isArray(r.trips) ? r.trips[0] : r.trips) as ReceiptRow['trips'],
    }))
    s.receipts_considered = rows.length

    // ---- receipt reminders ----
    const reminders = senders ? selectReminderCandidates(rows, now) : []
    s.reminder_receipts = reminders.length
    for (const r of reminders) {
      try {
        const { data: tagged, error: tErr } = await admin.rpc('_receipt_tagged', { p_expense_id: r.id })
        if (tErr) { if (isMissingFunction(tErr)) continue; throw tErr }
        const { data: resp, error: rErr } = await admin.from('expense_claim_responses').select('user_id').eq('expense_id', r.id)
        if (rErr) { if (isMissingColumnOrTable(rErr)) continue; throw rErr }
        const taggedIds = (tagged ?? []) as string[]
        const keys = taggedIds.flatMap((u) => tableNoticeKeys(r.id, u))
        const recent = new Set<string>()
        if (keys.length > 0) {
          const { data: sent, error: nErr } = await admin.from('notifications').select('user_id, dedupe_key')
            .in('dedupe_key', keys).gte('sent_at', tableNoticeCutoffIso(now))
          if (nErr) throw nErr // unknown recent-table state: do not guess
          for (const n of (sent ?? []) as Array<{ user_id: string }>) recent.add(n.user_id)
        }
        const who = reminderRecipients({
          tagged: taggedIds, payerId: r.paid_by,
          responded: new Set(((resp ?? []) as Array<{ user_id: string }>).map((x) => x.user_id)), recentTableNotice: recent,
        })
        for (const userId of who) {
          const out = await senders!.sendReceiptReminderNotice({ admin, expenseId: r.id, userId, deadline: r.claim_deadline! })
          if (out && out.sent) s.reminders_sent++
        }
      } catch (e) {
        s.errors++
        console.warn('[auto-chase] receipt reminder failed for', r.id, e instanceof Error ? e.message : e)
      }
    }

    // ---- apply deadlines (no provider needed, quiet hours never apply: the rule applies whether or not anyone is emailed) ----
    const due = selectApplyCandidates(rows, now)
    s.apply_candidates = due.length
    for (const r of due) {
      try {
        const { data: res, error: aErr } = await admin.rpc('apply_receipt_deadline', { p_expense_id: r.id })
        if (aErr) {
          if (isMissingFunction(aErr)) { s.rpc_missing = true; break }
          if (isPermanentApplyRefusal(aErr)) {
            // Not an error and not worth a daily line: log at info level and count it separately.
            s.apply_skipped++
            console.info('[auto-chase] receipt deadline not applied (permanent):', r.id, aErr.hint ?? 'refused')
            continue
          }
          throw aErr
        }
        const result = (res ?? null) as ApplyResult | null
        if (result?.skipped) {
          // The receipt is no longer itemised: the database answers quietly instead of raising. Not an error, nothing to retry.
          s.apply_skipped++
          console.info('[auto-chase] receipt deadline not applied (skipped):', r.id, result.skipped)
        } else if (result && result.applied === true && result.already_applied !== true) s.applied++
      } catch (e) {
        s.errors++
        console.warn('[auto-chase] apply deadline failed for', r.id, e instanceof Error ? e.message : e)
      }
    }

    // ---- result notices (recoverable): receipts closed in the last 7 days, charged people with no `result` notice yet ----
    if (senders && !s.rpc_missing) {
      const { data: closedData, error: cErr } = await admin
        .from('expenses').select(RECEIPT_SELECT)
        .not('claims_sent_at', 'is', null).not('claims_closed_at', 'is', null)
        .gte('claims_closed_at', new Date(now.getTime() - 7 * 24 * 3600_000).toISOString())
      if (cErr) {
        if (!isMissingColumnOrTable(cErr)) { s.errors++; console.warn('[auto-chase] receipt result query failed:', cErr.message) }
      } else {
        const closed = selectRecentlyClosed(
          ((closedData ?? []) as Array<ReceiptRow & { trips: unknown }>).map((r) => ({
            ...r, trips: (Array.isArray(r.trips) ? r.trips[0] : r.trips) as ReceiptRow['trips'],
          })),
          now,
        )
        s.result_receipts = closed.length
        for (const r of closed) {
          try {
            const { data: claims, error: clErr } = await admin.from('expense_item_claims').select('user_id, leftover_amount, amount_owed').eq('expense_id', r.id)
            if (clErr) throw clErr
            const charged = resultRecoveryRecipients({ claims: (claims ?? []) as Array<{ user_id: string }>, payerId: r.paid_by, alreadyNotified: new Set() })
            if (charged.length === 0) continue
            // Result keys carry the leftover amount (notice:receipt:<e>:<u>:result:<minor>): once per close, and after a reopen + re-close one more
            // time only if the person's amount changed (cap 2). The sender re-checks; this only avoids pointless calls.
            const { data: have, error: nErr } = await admin.from('notifications').select('user_id, dedupe_key, sent_at')
              .eq('entity_id', r.id).eq('kind', RECEIPT_RESULT_KIND).in('user_id', charged.map((p) => p.userId))
            if (nErr) throw nErr // unknown: do not guess
            const keysBy = new Map<string, Array<{ key: string; at: number }>>()
            for (const n of (have ?? []) as Array<{ user_id: string; dedupe_key: string; sent_at?: string | null }>) {
              keysBy.set(n.user_id, [...(keysBy.get(n.user_id) ?? []), { key: n.dedupe_key, at: Date.parse(n.sent_at ?? '') || 0 }])
            }
            const currency = r.currency ?? r.trips?.base_currency ?? 'GBP'
            for (const p of charged) {
              const prior = (keysBy.get(p.userId) ?? []).sort((a, b) => a.at - b.at).map((x) => x.key)
              if (!decideResultSequence({ priorKeys: prior, leftoverMinor: toMinorUnits(p.amount, currency) }).send) continue
              try {
                const out = await senders.sendReceiptResultNotice({ admin, expenseId: r.id, userId: p.userId, amount: p.amount, totalAfter: p.totalAfter, currency: r.currency ?? r.trips?.base_currency ?? null })
                if (out && out.sent) s.result_notices_sent++
                else if (out && (out.reason === 'send_failed' || out.reason === 'state_failed' || out.reason === 'token_failed')) {
                  console.warn('[auto-chase] receipt result notice not sent (will retry next run):', r.id, out.reason)
                }
              } catch (e) {
                s.errors++
                console.warn('[auto-chase] receipt result notice failed for', r.id, p.userId, e instanceof Error ? e.message : e)
              }
            }
          } catch (e) {
            s.errors++
            console.warn('[auto-chase] receipt result notices failed for', r.id, e instanceof Error ? e.message : e)
          }
        }
      }
    }
  } catch (e) {
    s.errors++
    s.skipped_reason = 'pass_failed'
    console.warn('[auto-chase] receipt passes failed, continuing:', e instanceof Error ? e.message : e)
  }
  return s
}
