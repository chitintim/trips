/**
 * The trip's "Ideas" question (Add > An idea): a normal Choose-any group question
 * flagged with `metadata.ideas_bucket = true`. It is a place to collect
 * suggestions, not a question people owe an answer to, so it is never decided,
 * nudged or counted as a to-do. Kept out of src/lib/todos and src/lib/answers
 * (those are mirrored into supabase/functions/_shared).
 */
export const IDEAS_QUESTION_TITLE = 'Ideas'
export const IDEAS_BUCKET_KEY = 'ideas_bucket'

export function isIdeasBucket(section: { metadata?: unknown }): boolean {
  const m = section.metadata
  return !!m && typeof m === 'object' && !Array.isArray(m) && (m as Record<string, unknown>)[IDEAS_BUCKET_KEY] === true
}
