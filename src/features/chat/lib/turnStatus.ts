/**
 * The small status text under (or in place of) the streamed reply. It exists only while the turn is running:
 * once the stream has ended (done, error or cut off) nothing may remain, even while the stored reply is still being fetched.
 */
export function statusLine(i: { streaming: boolean; hasText: boolean; label: string | null }): string | null {
  if (!i.streaming) return i.hasText ? null : i.label
  return i.label ?? (i.hasText ? 'Working on it…' : 'Thinking…')
}
