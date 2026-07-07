import { useEffect } from 'react'
import { Modal, Button, Input, Select, useToast, ConfirmDiscardSheet } from '../../../components/ui'
import { useFormDraft, useUnsavedChangesGuard } from '../../../lib/forms'
import { useUpdateTrip } from '../../../lib/queries/useTrip'
import { useTripActivityLog } from '../lib/activity'
import { parseChaseSettings, type ChaseSettings } from '../lib/chaseSettings'
import type { Trip } from '../../../types'
import type { Json } from '../../../types/database.types'

interface ChaseFormValues {
  enabled: boolean
  delayHours: string
  quietEnabled: boolean
  quietStart: string
  quietEnd: string
  maxReminders: string
}

function fromSettings(s: ChaseSettings): ChaseFormValues {
  return {
    enabled: s.enabled,
    delayHours: String(s.delay_hours),
    quietEnabled: s.quiet_hours != null,
    quietStart: String(s.quiet_hours?.start ?? 22),
    quietEnd: String(s.quiet_hours?.end ?? 8),
    maxReminders: String(s.max_reminders),
  }
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }))

export interface ChaseSettingsSheetProps {
  isOpen: boolean
  onClose: () => void
  trip: Trip
}

/**
 * Per-trip auto-chase settings (plan §14) — writes trips.chase_settings
 * jsonb {enabled, delay_hours, quiet_hours, max_reminders}. Chase is
 * opt-IN: the toggle defaults to off for every trip.
 */
export function ChaseSettingsSheet({ isOpen, onClose, trip }: ChaseSettingsSheetProps) {
  const { showToast } = useToast()
  const updateTrip = useUpdateTrip(trip.id)
  const logActivity = useTripActivityLog(trip.id)

  const seed = fromSettings(parseChaseSettings(trip.chase_settings))
  // This sheet only ever edits the trip's existing chase settings (no
  // create mode) -- draft persistence is disabled so a stale autosave from
  // a previous open can never override the live trip record (Form & Flow
  // Standard §5.2).
  const { values, setValues, updateField, clearDraft } = useFormDraft<ChaseFormValues>(
    `chase-settings:${trip.id}`,
    seed,
    { enabled: false }
  )

  useEffect(() => {
    if (isOpen) setValues(fromSettings(parseChaseSettings(trip.chase_settings)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, trip.id])

  const isDirty = JSON.stringify(values) !== JSON.stringify(seed)
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isDirty)
  const handleClose = () => confirmClose(onClose)

  const handleSave = async () => {
    const delay = parseInt(values.delayHours, 10)
    const maxReminders = parseInt(values.maxReminders, 10)
    if (Number.isNaN(delay) || delay < 0) {
      showToast({ type: 'error', message: 'Delay hours must be a non-negative number' })
      return
    }
    if (Number.isNaN(maxReminders) || maxReminders < 1) {
      showToast({ type: 'error', message: 'Max reminders must be at least 1' })
      return
    }
    const settings: ChaseSettings = {
      enabled: values.enabled,
      delay_hours: delay,
      quiet_hours: values.quietEnabled
        ? { start: parseInt(values.quietStart, 10), end: parseInt(values.quietEnd, 10) }
        : null,
      max_reminders: maxReminders,
    }
    try {
      await updateTrip.mutateAsync({ chase_settings: settings as unknown as Json })
      logActivity({ verb: 'chase_settings_updated', metadata: { enabled: settings.enabled } })
      showToast({
        type: 'success',
        message: settings.enabled ? 'Auto-chase enabled' : 'Auto-chase settings saved',
        description: settings.enabled ? 'Laggards get one bundled email per day, max.' : undefined,
      })
      clearDraft()
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not save settings', description: (err as Error).message })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="md" title="Auto-chase settings">
      <div className="space-y-5">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={values.enabled}
            onChange={(e) => updateField('enabled', e.target.checked)}
            className="mt-1 w-5 h-5 accent-accent-600"
          />
          <span>
            <span className="block text-sm font-medium text-[var(--text-primary)]">Enable auto-chase for this trip</span>
            <span className="block text-xs text-[var(--text-muted)] mt-0.5">
              A daily job emails each laggard a deep link to their exact action — unvoted polls, unclaimed items,
              pending RSVPs, unpaid settlements. Off by default; nobody is emailed until you turn it on.
            </span>
          </span>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Wait before first chase (hours)"
            type="number"
            min={0}
            value={values.delayHours}
            onChange={(e) => updateField('delayHours', e.target.value)}
            helperText="How long an item stays open before chasing"
          />
          <Input
            label="Max reminders per item"
            type="number"
            min={1}
            max={10}
            value={values.maxReminders}
            onChange={(e) => updateField('maxReminders', e.target.value)}
            helperText="Then it escalates to this board"
          />
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={values.quietEnabled}
              onChange={(e) => updateField('quietEnabled', e.target.checked)}
              className="w-5 h-5 accent-accent-600"
            />
            <span className="text-sm font-medium text-[var(--text-primary)]">Quiet hours (no emails)</span>
          </label>
          {values.quietEnabled && (
            <div className="grid grid-cols-2 gap-3 pl-8">
              <Select
                label="From"
                value={values.quietStart}
                onChange={(e) => updateField('quietStart', e.target.value)}
                options={HOUR_OPTIONS}
              />
              <Select
                label="Until"
                value={values.quietEnd}
                onChange={(e) => updateField('quietEnd', e.target.value)}
                options={HOUR_OPTIONS}
              />
            </div>
          )}
        </div>

        <p className="rounded-[var(--radius-md)] bg-[var(--surface-sunken)] px-3 py-2 text-xs text-[var(--text-muted)]">
          ✉️ Emails go out only if the email channel (Brevo) is configured on the server. If it isn't, auto-chase
          still runs and queues WhatsApp-ready drafts on this board instead — and people who opted out of emails are
          never contacted.
        </p>

        <div className="flex justify-end gap-3 pt-2 border-t border-[var(--border-subtle)]">
          <Button variant="ghost" onClick={handleClose} disabled={updateTrip.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSave} isLoading={updateTrip.isPending}>
            Save settings
          </Button>
        </div>
      </div>

      <ConfirmDiscardSheet
        isOpen={guardProps.showConfirm}
        onKeep={guardProps.onKeep}
        onDiscard={() => {
          clearDraft()
          guardProps.onDiscard()
        }}
      />
    </Modal>
  )
}
