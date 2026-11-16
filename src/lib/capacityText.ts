/** One wording for capacity, so "1/8" never has to be decoded. Pure. */
export function capacityLine(confirmed: number, limit: number | null): string {
  if (!limit) return `${confirmed} going · No limit`
  const left = Math.max(0, limit - confirmed)
  if (confirmed >= limit) return `${confirmed} of ${limit} places taken · Full`
  return `${confirmed} of ${limit} places taken · ${left} left`
}

/** Quiet note when more people are invited than there are places; null otherwise. */
export function invitedOverCapacityNote(invited: number | undefined, limit: number | null): string | null {
  if (!limit || invited === undefined || invited <= limit) return null
  return `${invited} invited for ${limit} places`
}

/** Dashboard trip card: "1 going · 8 places". */
export function dashboardCapacityLabel(confirmed: number, limit: number | null): string {
  return limit ? `${confirmed} going · ${limit} places` : `${confirmed} going`
}
