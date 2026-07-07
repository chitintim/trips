import { useRef, useState } from 'react'

/**
 * Horizontal swipe-between-days (UX_REDESIGN.md Part 4 "Motion & identity
 * system"): a touch handler for the Plan board's day sections on mobile.
 *
 * Judgment call (per the workstream brief: "skip if it degrades scroll
 * UX"): the Plan board is a single continuous VERTICAL scroll of every
 * trip day (not a paged carousel) — that's deliberate, it's what lets
 * someone scan the whole trip in one gesture. Converting it into a fully
 * paged horizontal carousel would remove that at-a-glance overview and
 * fight the browser's native vertical scroll (a horizontal drag that
 * *replaces* the day's content is exactly the kind of interaction that
 * makes a scrollable list feel broken on mobile).
 *
 * So this hook implements the lighter-weight version the brief allows: a
 * horizontal pan on a day section nudges its content with a translateX
 * "rubber-band" preview, and a swipe past the threshold smooth-scrolls the
 * page to the next/previous day's sticky header (a same-page anchor jump)
 * instead of replacing content. Released/short drags spring back to
 * translateX(0) via the shared --ease-spring token. Vertical drags are
 * ignored immediately (axis lock) so normal scrolling is never intercepted.
 */
export interface DaySwipeHandlers {
  onTouchStart: (e: React.TouchEvent) => void
  onTouchMove: (e: React.TouchEvent) => void
  onTouchEnd: () => void
  /** Spread onto the panned element's style. */
  style: { transform: string; transition: string }
}

const SWIPE_THRESHOLD_PX = 56
const AXIS_LOCK_PX = 10

export function useDaySwipe(onSwipeLeft: () => void, onSwipeRight: () => void): DaySwipeHandlers {
  const startX = useRef(0)
  const startY = useRef(0)
  const deltaX = useRef(0)
  const axis = useRef<'x' | 'y' | null>(null)
  const [dragPx, setDragPx] = useState(0)
  const [isDragging, setIsDragging] = useState(false)

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0]
    startX.current = t.clientX
    startY.current = t.clientY
    deltaX.current = 0
    axis.current = null
  }

  const onTouchMove = (e: React.TouchEvent) => {
    const t = e.touches[0]
    const dx = t.clientX - startX.current
    const dy = t.clientY - startY.current

    if (axis.current === null) {
      if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return
      axis.current = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    }
    if (axis.current === 'y') return // native vertical scroll wins — never intercepted

    deltaX.current = dx
    setIsDragging(true)
    // Rubber-band: soften movement past the threshold instead of a hard stop.
    const clamped =
      Math.abs(dx) > SWIPE_THRESHOLD_PX ? Math.sign(dx) * (SWIPE_THRESHOLD_PX + (Math.abs(dx) - SWIPE_THRESHOLD_PX) * 0.25) : dx
    setDragPx(clamped)
  }

  const onTouchEnd = () => {
    if (isDragging && axis.current === 'x') {
      if (deltaX.current <= -SWIPE_THRESHOLD_PX) onSwipeLeft()
      else if (deltaX.current >= SWIPE_THRESHOLD_PX) onSwipeRight()
    }
    setIsDragging(false)
    setDragPx(0)
    axis.current = null
  }

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    style: {
      transform: `translateX(${dragPx}px)`,
      transition: isDragging ? 'none' : 'transform var(--duration-fast) var(--ease-spring)',
    },
  }
}
