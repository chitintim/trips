/**
 * Avatar system v2 (UX_REDESIGN.md "Avatar system v2"): ~28 travel/holiday
 * themed flat SVG icons for the "Icons" avatar type
 * (`avatar_data: {type:'icon', icon:'mountain', bgColor:'...'}`).
 *
 * Design conventions, kept consistent across the whole set:
 *  - 24x24 viewBox, simple/geometric/flat shapes (no gradients, no photo
 *    realism) so they read clearly at small avatar sizes (as small as
 *    `xs` = 24px).
 *  - Each icon uses `currentColor` for its primary shape (so it inherits
 *    the icon's foreground color from CSS) plus 1-2 fixed accent tones for
 *    a little character (e.g. a sun, a flame, water) -- "2-3 token colors
 *    each" per spec. Accent colors are plain hex, not design-system
 *    tokens, because these render on arbitrary user-picked bgColors and
 *    need to stay legible/on-brand regardless of theme.
 *  - No `<svg>` wrapper props beyond className -- ICON_REGISTRY below is
 *    the single source of truth callers use; components are internal.
 */
import type { SVGProps } from 'react'

type IconComponent = (props: SVGProps<SVGSVGElement>) => JSX.Element

const base = (props: SVGProps<SVGSVGElement>) => ({
  viewBox: '0 0 24 24',
  fill: 'none',
  'aria-hidden': true as const,
  ...props,
})

const Mountain: IconComponent = (p) => (
  <svg {...base(p)}>
    <path d="M2 19 9 7l4 6.5L15 10l7 9z" fill="currentColor" />
    <path d="M9 7l2.2 3.7-2.7 1.7L6 17H2z" fill="currentColor" opacity="0.55" />
    <circle cx="18" cy="6" r="2" fill="#f6b93b" />
  </svg>
)

const Snowflake: IconComponent = (p) => (
  <svg {...base(p)}>
    <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M12 3v18M4.5 7.5l15 9M19.5 7.5l-15 9" />
    </g>
    <circle cx="12" cy="12" r="2" fill="#5fc9e8" />
  </svg>
)

const Palm: IconComponent = (p) => (
  <svg {...base(p)}>
    <path d="M12 22V11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M12 11c-2-3-6-4-9-2 3 3 6 3 9 2Zm0 0c2-3 6-4 9-2-3 3-6 3-9 2Zm0 0c-1-3 0-6 2-8-3 0-5 3-5 5 0 1 1 2 3 3Zm0 0c1-3 0-6-2-8 3 0 5 3 5 5 0 1-1 2-3 3Z" fill="currentColor" />
    <circle cx="12" cy="20" r="1.6" fill="#c47a3d" />
  </svg>
)

const Wave: IconComponent = (p) => (
  <svg {...base(p)}>
    <path d="M2 15c2-2 4-2 6 0s4 2 6 0 4-2 6 0 4 2 6 0" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
    <path d="M2 19c2-2 4-2 6 0s4 2 6 0 4-2 6 0 4 2 6 0" stroke="#5fc9e8" strokeWidth="1.8" fill="none" strokeLinecap="round" />
  </svg>
)

const Compass: IconComponent = (p) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
    <path d="M15 9l-2 6-6 2 2-6z" fill="#e8593a" />
  </svg>
)

const Backpack: IconComponent = (p) => (
  <svg {...base(p)}>
    <path d="M7 10a5 5 0 0 1 10 0v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z" fill="currentColor" />
    <rect x="9" y="4" width="6" height="4" rx="1.5" fill="currentColor" opacity="0.6" />
    <rect x="9.5" y="14" width="5" height="4" rx="1" fill="#f6b93b" />
  </svg>
)

const Camper: IconComponent = (p) => (
  <svg {...base(p)}>
    <rect x="2" y="8" width="16" height="9" rx="2" fill="currentColor" />
    <path d="M18 11h3l1 3v3h-4z" fill="currentColor" opacity="0.6" />
    <circle cx="7" cy="19" r="1.6" fill="#2b2b2b" />
    <circle cx="18" cy="19" r="1.6" fill="#2b2b2b" />
    <rect x="5" y="11" width="4" height="3" rx="0.5" fill="#5fc9e8" />
  </svg>
)

const Sushi: IconComponent = (p) => (
  <svg {...base(p)}>
    <rect x="3" y="9" width="18" height="8" rx="4" fill="#f5f0e6" />
    <rect x="3" y="9" width="18" height="8" rx="4" stroke="currentColor" strokeWidth="1.4" />
    <rect x="9" y="9" width="6" height="8" fill="currentColor" opacity="0.85" />
    <circle cx="12" cy="13" r="1.6" fill="#e8593a" />
  </svg>
)

const Croissant: IconComponent = (p) => (
  <svg {...base(p)}>
    <path d="M3 16c2-8 8-11 9-11s-1 5 3 7 6-1 6 2c0 4-6 6-9 6-4 0-9.5-1-9-4Z" fill="#e0a84f" />
    <path d="M6 13c2-4 5-6 6-6M9 16c2-3 5-4 6-3" stroke="#8a5a2b" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
)

const Cocktail: IconComponent = (p) => (
  <svg {...base(p)}>
    <path d="M4 4h16l-7 8v6h3v2H8v-2h3v-6z" fill="currentColor" />
    <circle cx="14.5" cy="6.5" r="1.4" fill="#e8593a" />
  </svg>
)

const HotSpring: IconComponent = (p) => (
  <svg {...base(p)}>
    <ellipse cx="12" cy="17" rx="9" ry="4" fill="#5fc9e8" />
    <ellipse cx="12" cy="17" rx="9" ry="4" stroke="currentColor" strokeWidth="1.4" fill="none" />
    <path d="M9 6c-1 2 2 2 1 4M13 5c-1 2 2 2 1 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
  </svg>
)

const CableCar: IconComponent = (p) => (
  <svg {...base(p)}>
    <path d="M3 5l18 3" stroke="currentColor" strokeWidth="1.4" />
    <path d="M9 8v3M14 8.8v3" stroke="currentColor" strokeWidth="1.2" />
    <rect x="7" y="11" width="10" height="7" rx="1.5" fill="currentColor" />
    <rect x="9.5" y="13.2" width="5" height="2.6" fill="#f6b93b" />
  </svg>
)

const Passport: IconComponent = (p) => (
  <svg {...base(p)}>
    <rect x="5" y="3" width="14" height="18" rx="2" fill="currentColor" />
    <circle cx="12" cy="10" r="3" fill="none" stroke="#f5f0e6" strokeWidth="1.3" />
    <path d="M8 17h8" stroke="#f5f0e6" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
)

const Polaroid: IconComponent = (p) => (
  <svg {...base(p)}>
    <rect x="4" y="3" width="16" height="17" rx="1.5" fill="#f5f0e6" stroke="currentColor" strokeWidth="1.2" />
    <rect x="6" y="5" width="12" height="9" fill="#5fc9e8" />
    <circle cx="12" cy="9.5" r="2.4" fill="#f6b93b" />
  </svg>
)

const Campfire: IconComponent = (p) => (
  <svg {...base(p)}>
    <path d="M5 20l5-5m4 5-5-5m9 5-5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <path d="M12 6c2 3-1 3 0 6 2-1 3-2 3-4 2 2 2 5-1 7-3 1.5-6.5 0-6-3.5.3-2 1.6-3 2-5.5Z" fill="#e8593a" />
  </svg>
)

const Sailing: IconComponent = (p) => (
  <svg {...base(p)}>
    <path d="M12 3v13" stroke="currentColor" strokeWidth="1.4" />
    <path d="M12 4l5 8h-5z" fill="currentColor" opacity="0.8" />
    <path d="M12 6l-4 9h4z" fill="currentColor" />
    <path d="M3 19c2 2 4 2 6 0s4 2 6 0 4 2 6 0" stroke="#5fc9e8" strokeWidth="1.6" fill="none" strokeLinecap="round" />
  </svg>
)

const Skis: IconComponent = (p) => (
  <svg {...base(p)}>
    <path d="M6 21 4 8c-.2-1 .5-2 1.5-2s1.7.7 1.9 1.7L9.5 21" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    <path d="M18 21 16 8c-.2-1 .5-2 1.5-2s1.7.7 1.9 1.7l2.1 13.3" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    <path d="M4 13h5M15 13h5" stroke="#e8593a" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
)

const Onsen: IconComponent = (p) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" fill="currentColor" />
    <path d="M7 14c2 1 3-1 5 0s3-1 5 0" stroke="#f5f0e6" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    <path d="M7 10c2 1 3-1 5 0s3-1 5 0" stroke="#f5f0e6" strokeWidth="1.4" fill="none" strokeLinecap="round" />
  </svg>
)

const Torii: IconComponent = (p) => (
  <svg {...base(p)}>
    <rect x="3" y="6" width="18" height="2.2" rx="1" fill="#e8593a" />
    <rect x="3" y="9.5" width="18" height="1.6" rx="0.8" fill="currentColor" />
    <rect x="6" y="8" width="1.8" height="12" fill="currentColor" />
    <rect x="16.2" y="8" width="1.8" height="12" fill="currentColor" />
  </svg>
)

const Lighthouse: IconComponent = (p) => (
  <svg {...base(p)}>
    <path d="M10 21h4l-1-13h-2z" fill="currentColor" />
    <path d="M9 8h6l-1-4H10z" fill="currentColor" opacity="0.7" />
    <circle cx="12" cy="4" r="1.6" fill="#f6b93b" />
    <path d="M2 21h20" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
)

const Cactus: IconComponent = (p) => (
  <svg {...base(p)}>
    <path d="M11 21V8a2 2 0 1 1 4 0v13" fill="currentColor" />
    <path d="M11 11H8a2 2 0 0 1-2-2V6M13 14h3a2 2 0 0 0 2-2V9" stroke="currentColor" strokeWidth="2.2" fill="none" strokeLinecap="round" />
    <ellipse cx="13" cy="21" rx="6" ry="1.4" fill="#c47a3d" />
  </svg>
)

const Aurora: IconComponent = (p) => (
  <svg {...base(p)}>
    <path d="M2 16c3-6 6 4 9-2s6 4 11-3" stroke="#5fc9e8" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    <path d="M2 19c3-5 6 3 9-1s6 3 11-4" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" opacity="0.7" />
    <circle cx="12" cy="5" r="1.4" fill="#f5f0e6" />
  </svg>
)

const HotAirBalloon: IconComponent = (p) => (
  <svg {...base(p)}>
    <path d="M12 2c4 0 6 4 6 7.5S15 16 12 16s-6-3-6-6.5S8 2 12 2Z" fill="currentColor" />
    <path d="M9 15l-1.5 3M15 15l1.5 3" stroke="currentColor" strokeWidth="1.2" />
    <rect x="9.5" y="18" width="5" height="3" rx="0.8" fill="#f6b93b" />
  </svg>
)

const Coconut: IconComponent = (p) => (
  <svg {...base(p)}>
    <circle cx="12" cy="14" r="7" fill="currentColor" />
    <circle cx="10" cy="12" r="1.1" fill="#f5f0e6" />
    <circle cx="14" cy="12" r="1.1" fill="#f5f0e6" />
    <circle cx="12" cy="15" r="1.1" fill="#f5f0e6" />
    <path d="M12 7c-3-3-6-2-8-4 3 0 6 0 8 2Zm0 0c3-3 6-2 8-4-3 0-6 0-8 2Z" fill="#3fae5a" />
  </svg>
)

const Gondola: IconComponent = (p) => (
  <svg {...base(p)}>
    <path d="M3 12c3-4 15-4 18 0" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    <path d="M4 12c2 4 14 4 16 0" fill="#e8593a" />
    <path d="M4 12c2 4 14 4 16 0" stroke="currentColor" strokeWidth="1.2" fill="none" />
  </svg>
)

const Tent: IconComponent = (p) => (
  <svg {...base(p)}>
    <path d="M12 4 3 20h18z" fill="currentColor" />
    <path d="M12 4l4.5 16" stroke="#f5f0e6" strokeWidth="1.3" />
    <path d="M10 20l2-6 2 6" fill="#f5f0e6" />
  </svg>
)

const Surfboard: IconComponent = (p) => (
  <svg {...base(p)}>
    <path d="M12 2c4 6 4 14 0 20-4-6-4-14 0-20Z" fill="currentColor" />
    <path d="M12 5v14" stroke="#f5f0e6" strokeWidth="1.2" />
    <path d="M2 20c2-2 4-2 6 0" stroke="#5fc9e8" strokeWidth="1.4" fill="none" strokeLinecap="round" />
  </svg>
)

const WorldMap: IconComponent = (p) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
    <path d="M3 12h18M12 3c2.5 2.5 2.5 15.5 0 18M12 3c-2.5 2.5-2.5 15.5 0 18" stroke="currentColor" strokeWidth="1.2" fill="none" />
    <circle cx="15" cy="9" r="1.3" fill="#e8593a" />
  </svg>
)

export const ICON_REGISTRY = {
  mountain: Mountain,
  snowflake: Snowflake,
  palm: Palm,
  wave: Wave,
  compass: Compass,
  backpack: Backpack,
  camper: Camper,
  sushi: Sushi,
  croissant: Croissant,
  cocktail: Cocktail,
  'hot-spring': HotSpring,
  'cable-car': CableCar,
  passport: Passport,
  polaroid: Polaroid,
  campfire: Campfire,
  sailing: Sailing,
  skis: Skis,
  onsen: Onsen,
  torii: Torii,
  lighthouse: Lighthouse,
  cactus: Cactus,
  aurora: Aurora,
  'hot-air-balloon': HotAirBalloon,
  coconut: Coconut,
  gondola: Gondola,
  tent: Tent,
  surfboard: Surfboard,
  'world-map': WorldMap,
} as const satisfies Record<string, IconComponent>

export type AvatarIconName = keyof typeof ICON_REGISTRY

export const AVATAR_ICON_NAMES = Object.keys(ICON_REGISTRY) as AvatarIconName[]

export function isAvatarIconName(value: unknown): value is AvatarIconName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ICON_REGISTRY, value)
}
