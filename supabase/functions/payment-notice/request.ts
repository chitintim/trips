// Request parsing for payment-notice (pure, unit-tested).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type NoticeRequest = { ok: true; settlementId: string; event: 'paid' | 'confirmed' } | { ok: false; error: string }

export function parseNoticeRequest(body: unknown): NoticeRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Invalid request' }
  const b = body as Record<string, unknown>
  if (typeof b.settlement_id !== 'string' || !UUID_RE.test(b.settlement_id)) return { ok: false, error: 'Invalid settlement' }
  if (b.event !== undefined && b.event !== 'paid' && b.event !== 'confirmed') return { ok: false, error: 'Invalid event' }
  return { ok: true, settlementId: b.settlement_id.toLowerCase(), event: b.event === 'confirmed' ? 'confirmed' : 'paid' }
}
