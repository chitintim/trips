import type { CSSProperties } from 'react'

/**
 * Per-trip accent hue support.
 *
 * The design system's accent scale lives on CSS custom properties
 * (--color-accent-50 … --color-accent-950, see src/index.css). Setting
 * those same variable names on a `[data-trip-accent]` ancestor (e.g. the
 * trip page root) re-themes every `bg-accent-*` / `text-accent-*` /
 * `border-accent-*` utility beneath it — no per-component changes needed.
 *
 * Today there's no `accent_hue` column on `trips` yet (schema owned by the
 * Foundation workstream), so the hue is derived deterministically from the
 * trip id. Once a real column exists, pass it as `hue` and this keeps
 * working unchanged — same contract, real data instead of a hash.
 */

export interface TripAccentScale {
  50: string
  100: string
  200: string
  300: string
  400: string
  500: string
  600: string
  700: string
  800: string
  900: string
  950: string
}

/** Deterministic 0-359 hue from any stable string (trip id, name, etc). */
export function hueFromSeed(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash) % 360
}

/**
 * Build a full accent scale (lightness/saturation curve matched to the
 * default teal token scale) for an arbitrary hue.
 */
export function buildAccentScale(hue: number): TripAccentScale {
  const s = (l: number, sat: number) => `hsl(${hue} ${sat}% ${l}%)`
  return {
    50: s(96, 55),
    100: s(91, 55),
    200: s(83, 50),
    300: s(70, 45),
    400: s(56, 42),
    500: s(42, 55),
    600: s(34, 55),
    700: s(28, 50),
    800: s(23, 45),
    900: s(19, 42),
    950: s(12, 40),
  }
}

/**
 * CSS custom property object suitable for spreading onto a `style` prop,
 * e.g. `<div data-trip-accent style={getTripAccentStyle(trip.id)}>`.
 */
export function getTripAccentStyle(seedOrHue: string | number): CSSProperties {
  const hue = typeof seedOrHue === 'number' ? seedOrHue : hueFromSeed(seedOrHue)
  const scale = buildAccentScale(hue)
  return Object.fromEntries(
    Object.entries(scale).map(([shade, value]) => [`--color-accent-${shade}`, value])
  ) as CSSProperties
}
