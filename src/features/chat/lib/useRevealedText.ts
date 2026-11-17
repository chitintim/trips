import { useEffect, useRef, useState } from 'react'

/** How many characters to show next, given what is shown and what has arrived. Big bursts are spread over a few frames. */
export function nextRevealLength(shown: number, total: number): number {
  const remaining = total - shown
  if (remaining <= 0) return total
  return shown + Math.max(3, Math.ceil(remaining / 10))
}

/**
 * Shows `full` progressively. Text that arrives in one burst is revealed over ~10 frames instead of jumping in;
 * when `active` turns false everything is shown at once.
 */
export function useRevealedText(full: string, active: boolean): string {
  const [shown, setShown] = useState(0)
  const raf = useRef<number | null>(null)
  const shownRef = useRef(0)
  shownRef.current = shown

  useEffect(() => {
    if (!active) return
    const step = () => {
      raf.current = null
      const next = nextRevealLength(shownRef.current, full.length)
      if (next !== shownRef.current) {
        shownRef.current = next
        setShown(next)
      }
      if (next < full.length) raf.current = requestAnimationFrame(step)
    }
    if (shownRef.current < full.length && raf.current === null) raf.current = requestAnimationFrame(step)
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current)
      raf.current = null
    }
  }, [full, active])

  if (!active) return full
  return full.slice(0, Math.min(shown, full.length))
}
