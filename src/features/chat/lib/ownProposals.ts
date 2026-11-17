/** The legacy organiser proposals this person may see in their private chat: their own pending, unexpired ones only. */
export function ownPendingProposals<P extends { created_by: string; status: string; expires_at: string | null }>(proposals: P[] | undefined, userId: string | undefined, canManage: boolean, nowMs: number): P[] {
  if (!canManage || !userId) return []
  return (proposals ?? []).filter((p) => p.created_by === userId && p.status === 'pending' && (!p.expires_at || new Date(p.expires_at).getTime() > nowMs))
}
