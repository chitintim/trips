/** Label for the People tab's RSVP button: Reply (no answer yet) / View my answer (confirmed) / Update my answer. */
export function rsvpButtonLabel(status: string | null | undefined): string {
  if (!status || status === 'pending') return 'Reply'
  if (status === 'confirmed') return 'View my answer'
  return 'Update my answer'
}
