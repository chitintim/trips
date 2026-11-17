/**
 * Short, unambiguous names for the people on one receipt (chips, tabs, totals, headers).
 *
 * Rule: the first name, plus the least extra it takes to tell two people apart.
 *   - first names are different:            "Tim", "Sam"
 *   - same first name, bracketed part:       "Tim (Test)"   (the brackets are what the person chose to tell themselves apart)
 *   - same first name, otherwise:            "Tim L." / "Tim T." (last initial)
 *   - initials collide too:                  "Tim Lam" / "Tim Lee" (the rest of the name, whole words only)
 *   - truly identical names:                 "Tim Lam", "Tim Lam (2)"
 * A name is never cut mid-word with a dot: the only dot is after a single-letter initial. Long names are returned whole; the screen
 * lets chips wrap instead of truncating. `full` is the complete name for aria-labels and titles.
 */

export interface NameSource {
  id: string
  fullName?: string | null
  email?: string | null
}

export interface DisplayName {
  /** Short label, unique within the set it was computed for. */
  label: string
  /** The person's whole name (or email name) for aria-label / title. */
  full: string
}

function cleanTokens(fullName: string | null | undefined): string[] {
  return (fullName ?? '').trim().split(/\s+/).filter(Boolean)
}

/** Text of the first "(...)" token group, brackets included: "Tim (Test) Lam" -> "(Test)". */
function bracketOf(tokens: string[]): string | null {
  const start = tokens.findIndex((t, i) => i > 0 && t.startsWith('('))
  if (start < 0) return null
  const parts: string[] = []
  for (let i = start; i < tokens.length; i++) {
    parts.push(tokens[i])
    if (tokens[i].endsWith(')')) return parts.join(' ')
  }
  return null
}

function initialOf(word: string): string {
  const first = Array.from(word.replace(/^[("'“]+/, ''))[0]
  return first ? first.toLocaleUpperCase() : ''
}

interface Parsed {
  first: string
  /** Progressively fuller labels, each different from the one before. Always starts with the first name. */
  candidates: string[]
  full: string
}

function parse(src: NameSource): Parsed {
  const tokens = cleanTokens(src.fullName)
  if (tokens.length === 0) {
    const fromEmail = (src.email ?? '').split('@')[0].trim()
    const name = fromEmail || 'Someone'
    return { first: name, candidates: [name], full: src.email?.trim() || name }
  }
  const first = tokens[0]
  const bracket = bracketOf(tokens)
  const bracketStart = bracket ? tokens.findIndex((t, i) => i > 0 && t.startsWith('(')) : -1
  const bracketLen = bracket ? bracket.split(' ').length : 0
  // The "real" last name words: everything after the first name that is not inside the brackets.
  const rest = tokens.slice(1).filter((_, i) => !(bracket && i + 1 >= bracketStart && i + 1 < bracketStart + bracketLen))
  const candidates = [first]
  const push = (c: string) => {
    if (c && !candidates.includes(c)) candidates.push(c)
  }
  if (bracket) push(`${first} ${bracket}`)
  if (rest.length > 0) {
    const last = rest[rest.length - 1]
    const initial = initialOf(last)
    // A last "name" that already is a single letter ("Tim L") is its own initial.
    if (initial) push(`${first} ${initial}.`)
    push(`${first} ${rest.join(' ')}`)
  }
  push(tokens.join(' '))
  return { first, candidates, full: tokens.join(' ') }
}

/**
 * Labels for one set of people (a receipt). Everyone is shown by first name unless it clashes with another person's; only the
 * clashing people get more, and only as much as it takes.
 */
export function displayNames(people: NameSource[]): Map<string, DisplayName> {
  const parsed = people.map((p) => ({ id: p.id, ...parse(p) }))
  const level = new Map<string, number>(parsed.map((p) => [p.id, 0]))
  const labelAt = (p: (typeof parsed)[number]) => p.candidates[Math.min(level.get(p.id) ?? 0, p.candidates.length - 1)]
  const key = (s: string) => s.toLocaleLowerCase()

  // People sharing a first name start one step in (their bracket or initial), the rest stay on the first name alone.
  const byFirst = new Map<string, typeof parsed>()
  for (const p of parsed) byFirst.set(key(p.first), [...(byFirst.get(key(p.first)) ?? []), p])
  for (const group of byFirst.values()) if (group.length > 1) for (const p of group) level.set(p.id, p.candidates.length > 1 ? 1 : 0)

  // Anyone still sharing a label with someone else steps up one level, until labels differ or nobody has more to show.
  for (let guard = 0; guard < 8; guard++) {
    const counts = new Map<string, number>()
    for (const p of parsed) counts.set(key(labelAt(p)), (counts.get(key(labelAt(p))) ?? 0) + 1)
    let moved = false
    for (const p of parsed) {
      if ((counts.get(key(labelAt(p))) ?? 0) > 1 && (level.get(p.id) ?? 0) < p.candidates.length - 1) {
        level.set(p.id, (level.get(p.id) ?? 0) + 1)
        moved = true
      }
    }
    if (!moved) break
  }

  // Identical names cannot be told apart by name: number the later ones.
  const seen = new Map<string, number>()
  const out = new Map<string, DisplayName>()
  for (const p of parsed) {
    const base = labelAt(p)
    const n = (seen.get(key(base)) ?? 0) + 1
    seen.set(key(base), n)
    out.set(p.id, { label: n > 1 ? `${base} (${n})` : base, full: p.full })
  }
  return out
}
