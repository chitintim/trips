// Native date/time controls need extra sizing rules on iOS/WebKit (see the
// matching block in src/index.css). Kept separate from Input.tsx so the
// rules can be unit-tested without a DOM.

const DATE_LIKE_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week'])

export function isDateLikeType(type: string | undefined): boolean {
  return !!type && DATE_LIKE_TYPES.has(type)
}

// min-w-0 / max-w-full: iOS gives these inputs an intrinsic minimum width that
// otherwise pushes them past their grid column.
export const DATE_LIKE_INPUT_CLASSES = 'min-w-0 max-w-full text-left'

// The grid/flex item is this wrapper, whose min-width:auto is what let the
// column blow out, so it must always be shrinkable.
export const INPUT_WRAPPER_CLASSES = 'min-w-0'
