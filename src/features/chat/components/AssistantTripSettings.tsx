import { Modal, SegmentedControl, Skeleton, useToast } from '../../../components/ui'
import { actionsChoices, effectiveLabel, tripControlState, type TripActionsSetting, type TripChatSetting } from '../lib/chatSettings'
import { useChatAvailability, useSetTripChatSettings } from '../lib/useChatSettings'

const ON_OFF = [
  { value: 'inherit', label: 'On' },
  { value: 'off', label: 'Off' },
]
const FORCE = [
  { value: 'inherit', label: 'Follow site' },
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
]

/** Trip "Assistant" sheet for organisers (and site admins): switch it off for this trip, and keep it from making changes. */
export function AssistantTripSettings({ tripId, isOpen, onClose }: { tripId: string; isOpen: boolean; onClose: () => void }) {
  const { showToast } = useToast()
  const { availability: a } = useChatAvailability(tripId)
  const save = useSetTripChatSettings(tripId)

  const change = (v: { chat?: TripChatSetting; actions?: TripActionsSetting }) =>
    save.mutate(v, { onError: (e) => showToast({ type: 'error', message: "Couldn't save that", description: (e as Error).message }) })

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md" title="Assistant">
      {!a || !a.canManage ? (
        <Skeleton variant="card" height={120} />
      ) : (
        (() => {
          const state = tripControlState(a)
          const chatValue = a.trip.chat === 'off' ? 'off' : 'inherit'
          // An organiser cannot set "On" but must still see it when a site admin did: shown as a fixed, disabled choice
          const lockedOn = !a.canForceOn && a.trip.actions === 'on'
          const actionsValue = a.canForceOn || lockedOn ? a.trip.actions : a.trip.actions === 'off' ? 'off' : 'inherit'
          const actionsOptions = [
            ...(a.canForceOn ? FORCE : ON_OFF).filter((o) => actionsChoices(a).includes(o.value as TripActionsSetting)).map((o) => ({ ...o, disabled: !!state.actionsDisabledReason || save.isPending })),
            ...(lockedOn ? [{ value: 'on', label: 'On (set by a site admin)', disabled: true }] : []),
          ]
          return (
            <div className="space-y-5">
              <p className="text-sm text-[var(--text-secondary)]">Right now: {effectiveLabel(a.chat, a.actions)}.</p>
              <div>
                <p className="mb-1 text-sm font-medium text-[var(--text-primary)]">Assistant on this trip</p>
                <SegmentedControl
                  aria-label="Assistant on this trip"
                  options={ON_OFF.map((o) => ({ ...o, disabled: !!state.chatDisabledReason || save.isPending }))}
                  value={chatValue}
                  onChange={(v) => change({ chat: v as TripChatSetting })}
                />
                {state.chatDisabledReason && <p className="mt-1 text-xs text-[var(--text-muted)]">{state.chatDisabledReason}</p>}
              </div>
              <div>
                <p className="mb-1 text-sm font-medium text-[var(--text-primary)]">Let it make changes with confirm cards</p>
                <SegmentedControl
                  aria-label="Let it make changes with confirm cards"
                  options={actionsOptions}
                  value={actionsValue}
                  onChange={(v) => change({ actions: v as TripActionsSetting })}
                />
                {state.actionsDisabledReason ? (
                  <p className="mt-1 text-xs text-[var(--text-muted)]">{state.actionsDisabledReason}</p>
                ) : (
                  <p className="mt-1 text-xs text-[var(--text-muted)]">Nothing changes until someone taps Confirm.</p>
                )}
              </div>
            </div>
          )
        })()
      )}
    </Modal>
  )
}
