import { useState, useEffect } from 'react'

type ScrollDirection = 'up' | 'down' | null

/**
 * Hook to detect scroll direction
 * Returns 'up', 'down', or null
 *
 * @param threshold - Minimum scroll distance to trigger direction change (default: 10px)
 * @returns Current scroll direction
 */
export function useScrollDirection(threshold: number = 10): ScrollDirection {
  const [scrollDirection, setScrollDirection] = useState<ScrollDirection>(null)

  useEffect(() => {
    let lastScrollY = window.scrollY
    let ticking = false

    const updateScrollDirection = () => {
      const scrollY = window.scrollY

      // Only update if scrolled more than threshold
      if (Math.abs(scrollY - lastScrollY) < threshold) {
        ticking = false
        return
      }

      // Determine direction
      const newDirection = scrollY > lastScrollY ? 'down' : 'up'

      // Only update if direction changed
      if (newDirection !== scrollDirection) {
        setScrollDirection(newDirection)
      }

      lastScrollY = scrollY > 0 ? scrollY : 0
      ticking = false
    }

    const onScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(updateScrollDirection)
        ticking = true
      }
    }

    window.addEventListener('scroll', onScroll)

    return () => {
      window.removeEventListener('scroll', onScroll)
    }
  }, [scrollDirection, threshold])

  return scrollDirection
}
