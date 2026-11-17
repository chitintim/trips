/**
 * TRIP_CHAT_ACTIONS: off (default) | on | comma-separated trip ids.
 * Gates ALL propose_* tools (they stay declared, so the tools array and the
 * prompt cache never change; they just answer "not switched on"). The LEGACY
 * organiser-only `propose_actions` changeset tool is NOT gated by it (as before).
 */
export function actionsEnabledFor(flag: string | undefined | null, tripId: string): boolean {
  const v = (flag ?? '').trim().toLowerCase()
  if (!v || v === 'off' || v === 'false' || v === '0') return false
  if (v === 'on' || v === 'true' || v === '1' || v === 'all') return true
  return v.split(',').map((s) => s.trim()).filter(Boolean).includes(tripId.toLowerCase())
}
