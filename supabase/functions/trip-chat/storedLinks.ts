/**
 * The link buttons of a turn (open_screen), kept on the assistant row's `metadata.links` so a reopened chat shows the
 * same buttons it showed live. Only the target and the ids/labels are stored, never a URL or an `?open=` string: the
 * client rebuilds the link from its own allow-list (src/features/chat/lib/linkTargets.ts).
 */
import { isBareTarget, isIdTarget } from './tools/propose/deepLinks.ts'
import type { ChatActionEnvelope } from './tools/types.ts'

export interface StoredLink {
  target: string
  id: string | null
  /** The plain title of what the button opens (a to-do, an expense...), when there is one. */
  subject: string | null
}

export const MAX_STORED_LINKS = 5
const MAX_SUBJECT_CHARS = 120

/** The stored form of an open_screen envelope, or null for any other action or a malformed one. */
export function storedLinkOf(a: ChatActionEnvelope): StoredLink | null {
  if (a.kind !== 'open_screen') return null
  const p = (a.params ?? {}) as { target?: unknown; id?: unknown }
  const target = typeof p.target === 'string' ? p.target : ''
  const id = typeof p.id === 'string' ? p.id : null
  if (!(isBareTarget(target) && id === null) && !(isIdTarget(target) && id)) return null
  const subject = (a.preview as { subject?: unknown } | null)?.subject
  return { target, id, subject: typeof subject === 'string' && subject.trim() ? subject.trim().slice(0, MAX_SUBJECT_CHARS) : null }
}
