import { useState } from 'react'
import { Button, Card, Modal, Select, SegmentedControl, Skeleton, useToast } from '../../../components/ui'
import { effectiveLabel, type ActionsScope, type AdminChatTripRow, type SiteMode, type TripActionsSetting, type TripChatSetting } from '../lib/chatSettings'
import { useAdminChatSettings, useSetAdminChatSettings, useSetTripChatSettings } from '../lib/useChatSettings'

const MODE_OPTIONS: { value: SiteMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'answers', label: 'Answers only' },
  { value: 'actions', label: 'Answers and actions' },
]
const SCOPE_OPTIONS: { value: ActionsScope; label: string }[] = [
  { value: 'upcoming', label: 'Upcoming trips' },
  { value: 'all', label: 'All trips' },
]
const CHAT_OPTIONS = [
  { value: 'inherit', label: 'Follow site' },
  { value: 'off', label: 'Off' },
]
const ACTIONS_OPTIONS = [
  { value: 'inherit', label: 'Follow site' },
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
]

const th = 'px-2 py-1 text-left font-medium text-[var(--text-secondary)]'
const td = 'px-2 py-1 align-middle'

const formatDate = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-GB') : '')
const dates = (r: AdminChatTripRow) => (r.startDate || r.endDate ? [formatDate(r.startDate), formatDate(r.endDate)].filter(Boolean).join(' to ') : 'No dates')

function TripRow({ row }: { row: AdminChatTripRow }) {
  const { showToast } = useToast()
  const save = useSetTripChatSettings(row.tripId)
  const change = (v: { chat?: TripChatSetting; actions?: TripActionsSetting }) =>
    save.mutate(v, { onError: (e) => showToast({ type: 'error', message: "Couldn't save that", description: (e as Error).message }) })
  return (
    <tr className="border-t border-[var(--border-subtle)]">
      <td className={td}>{row.name}</td>
      <td className={`${td} whitespace-nowrap`}>{dates(row)}</td>
      <td className={td}>
        <Select
          size="sm"
          aria-label={`Assistant on ${row.name}`}
          options={CHAT_OPTIONS}
          value={row.chat}
          disabled={save.isPending}
          onChange={(e) => change({ chat: e.target.value as TripChatSetting })}
        />
      </td>
      <td className={td}>
        <Select
          size="sm"
          aria-label={`Actions on ${row.name}`}
          options={ACTIONS_OPTIONS}
          value={row.actions}
          disabled={save.isPending}
          onChange={(e) => change({ actions: e.target.value as TripActionsSetting })}
        />
      </td>
      <td className={`${td} whitespace-nowrap`}>{effectiveLabel(row.effectiveChat, row.effectiveActions)}</td>
    </tr>
  )
}

/** Dashboard -> "Assistant" tab. Rendered only for site admins (same gate as "AI usage"; the RPCs enforce it too). */
export function AdminAssistantTab() {
  const { showToast } = useToast()
  const { data, isLoading, isError } = useAdminChatSettings(true)
  const save = useSetAdminChatSettings()
  const [confirmOff, setConfirmOff] = useState(false)

  if (isLoading) return <Skeleton variant="card" height={160} />
  if (isError || !data) return <p className="text-sm text-[var(--text-secondary)]">Couldn't load the assistant settings. Try again in a moment.</p>

  const apply = (v: { mode?: SiteMode; actionsScope?: ActionsScope }) =>
    save.mutate(v, { onError: (e) => showToast({ type: 'error', message: "Couldn't save that", description: (e as Error).message }) })

  const onMode = (mode: SiteMode) => {
    if (mode === data.mode) return
    if (mode === 'off') setConfirmOff(true)
    else apply({ mode })
  }
  const scopeDisabled = data.mode !== 'actions'

  return (
    <div className="space-y-6">
      <Card>
        <h2 className="text-base font-semibold text-[var(--text-primary)]">Trip assistant</h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">What the assistant does across the whole site. Each trip can switch it off, and you can switch actions on for one trip below.</p>

        <div className="mt-4 space-y-4">
          <div>
            <p className="mb-1 text-sm font-medium text-[var(--text-primary)]">Assistant</p>
            <SegmentedControl aria-label="Assistant mode" options={MODE_OPTIONS.map((o) => ({ ...o, disabled: save.isPending }))} value={data.mode} onChange={onMode} />
          </div>
          <div>
            <p className="mb-1 text-sm font-medium text-[var(--text-primary)]">Let it make changes on</p>
            <SegmentedControl
              aria-label="Where actions are allowed"
              options={SCOPE_OPTIONS.map((o) => ({ ...o, disabled: scopeDisabled || save.isPending }))}
              value={data.actionsScope}
              onChange={(actionsScope) => apply({ actionsScope })}
            />
            {scopeDisabled && <p className="mt-1 text-xs text-[var(--text-muted)]">Only applies when the assistant is set to Answers and actions.</p>}
          </div>
        </div>
      </Card>

      <section className="overflow-x-auto">
        <h3 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">By trip</h3>
        {data.trips.length === 0 ? (
          <p className="text-sm text-[var(--text-secondary)]">No trips yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr>
                {['Trip', 'Dates', 'Assistant', 'Actions', 'Result'].map((h) => (
                  <th key={h} className={th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.trips.map((r) => (
                <TripRow key={r.tripId} row={r} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Modal isOpen={confirmOff} onClose={() => setConfirmOff(false)} size="sm" title="Switch the assistant off?">
        <p className="text-sm text-[var(--text-secondary)]">The assistant disappears for everyone on every trip, and anything it suggested but nobody has confirmed yet can no longer be confirmed. You can switch it back on at any time.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmOff(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setConfirmOff(false)
              apply({ mode: 'off' })
            }}
          >
            Switch off
          </Button>
        </div>
      </Modal>
    </div>
  )
}
