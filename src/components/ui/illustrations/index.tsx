/**
 * Illustration identity (UX_REDESIGN.md Part 4 "Illustrations"): ~8
 * empty-state/hero illustrations extending the flat travel-icon style of
 * `src/components/ui/Avatar/icons/travelIcons.tsx` — same conventions:
 *  - simple/geometric/flat shapes (no gradients, no photo-realism),
 *    `currentColor` for the primary shape plus a couple of fixed accent
 *    hex tones for character.
 *  - Unlike the 24x24 avatar icons (built for tiny sizes), these are wider
 *    scene compositions (viewBox `0 0 200 140`) meant to sit centered in
 *    an EmptyState/hero at a larger display size, so they carry a touch
 *    more scene detail (horizon lines, simple props) while staying flat.
 *  - `currentColor` lets each usage tint the illustration via `className`
 *    (e.g. `text-[var(--text-muted)]` for a quiet empty state, or
 *    `text-accent-500` for a livelier hero), exactly like the avatar icons.
 *
 * Each component takes only `className` (+ standard SVG props) — no
 * per-icon prop surface, consistent with travelIcons.tsx's minimalism.
 */
import type { SVGProps } from 'react'

type IllustrationComponent = (props: SVGProps<SVGSVGElement>) => JSX.Element

const base = (props: SVGProps<SVGSVGElement>) => ({
  viewBox: '0 0 200 140',
  fill: 'none',
  'aria-hidden': true as const,
  ...props,
})

/** Plan board empty state: a blank day board with a dashed "add" slot. */
export const EmptyPlan: IllustrationComponent = (p) => (
  <svg {...base(p)}>
    <rect x="20" y="24" width="160" height="96" rx="10" fill="currentColor" opacity="0.06" />
    <rect x="20" y="24" width="160" height="96" rx="10" stroke="currentColor" strokeWidth="2" opacity="0.35" />
    <path d="M20 52h160" stroke="currentColor" strokeWidth="2" opacity="0.35" />
    <rect x="34" y="64" width="48" height="14" rx="4" fill="currentColor" opacity="0.18" />
    <rect x="34" y="84" width="70" height="14" rx="4" fill="currentColor" opacity="0.12" />
    <rect x="118" y="64" width="48" height="34" rx="6" stroke="#e8593a" strokeWidth="2" strokeDasharray="5 5" />
    <path d="M142 74v14M135 81h14" stroke="#e8593a" strokeWidth="2" strokeLinecap="round" />
    <circle cx="46" cy="36" r="4" fill="#f6b93b" />
  </svg>
)

/** Money feed empty state: an empty receipt/ledger with a soft coin. */
export const NoExpenses: IllustrationComponent = (p) => (
  <svg {...base(p)}>
    <path d="M62 20h60l10 10v82l-10 8H62l-10-8V30z" fill="currentColor" opacity="0.08" />
    <path d="M62 20h60l10 10v82l-10 8H62l-10-8V30z" stroke="currentColor" strokeWidth="2" opacity="0.4" />
    <path d="M74 44h40M74 60h40M74 76h24" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" opacity="0.4" />
    <circle cx="140" cy="96" r="20" fill="#f6b93b" />
    <path d="M132 96h16M140 88v16" stroke="#8a5a2b" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
)

/** Settle-up all-square: two hands meeting / a checkmark shield. */
export const AllSettled: IllustrationComponent = (p) => (
  <svg {...base(p)}>
    <circle cx="100" cy="70" r="46" fill="currentColor" opacity="0.06" />
    <path d="M100 30c14 0 28 6 34 12v26c0 20-16 34-34 40-18-6-34-20-34-40V42c6-6 20-12 34-12Z" fill="currentColor" opacity="0.85" />
    <path d="M84 70l12 12 22-24" stroke="#f5f0e6" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </svg>
)

/** Retrospective header: a photo/polaroid stack with a little celebration. */
export const RetroHeader: IllustrationComponent = (p) => (
  <svg {...base(p)}>
    <rect x="52" y="34" width="60" height="72" rx="4" fill="currentColor" opacity="0.15" transform="rotate(-6 82 70)" />
    <rect x="88" y="30" width="60" height="72" rx="4" fill="#f5f0e6" stroke="currentColor" strokeWidth="2" transform="rotate(5 118 66)" />
    <rect x="94" y="38" width="48" height="40" fill="#5fc9e8" transform="rotate(5 118 58)" />
    <circle cx="128" cy="52" r="7" fill="#f6b93b" transform="rotate(5 118 58)" />
    <path d="M30 40l4 8 8 2-8 3-4 8-3-8-8-3 8-2z" fill="#e8593a" />
    <path d="M164 92l3 6 6 2-6 2-3 6-2-6-6-2 6-2z" fill="#3fae5a" />
  </svg>
)

/** /join teaser fallback cover: a postcard/passport-stamp motif. */
export const JoinCover: IllustrationComponent = (p) => (
  <svg {...base(p)}>
    <rect x="26" y="26" width="148" height="88" rx="8" fill="currentColor" opacity="0.85" />
    <rect x="26" y="26" width="148" height="88" rx="8" stroke="#f5f0e6" strokeWidth="2" strokeDasharray="2 6" opacity="0.6" />
    <circle cx="146" cy="52" r="16" fill="none" stroke="#f5f0e6" strokeWidth="2" opacity="0.8" />
    <path d="M138 52h16M146 44v16" stroke="#f5f0e6" strokeWidth="2" opacity="0.8" />
    <path d="M42 78h64M42 90h44" stroke="#f5f0e6" strokeWidth="2.4" strokeLinecap="round" opacity="0.7" />
    <circle cx="150" cy="94" r="10" fill="#e8593a" />
  </svg>
)

/** Decide lens empty state ("nothing to decide"): a calm checklist, all ticked. */
export const NothingToDecide: IllustrationComponent = (p) => (
  <svg {...base(p)}>
    <rect x="46" y="24" width="108" height="96" rx="10" fill="currentColor" opacity="0.06" />
    <rect x="46" y="24" width="108" height="96" rx="10" stroke="currentColor" strokeWidth="2" opacity="0.35" />
    {[0, 1, 2].map((i) => (
      <g key={i} transform={`translate(0 ${i * 24})`}>
        <circle cx="64" cy="50" r="7" fill="#3fae5a" />
        <path d="M61 50l2.4 2.6L67.5 47" stroke="#f5f0e6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <rect x="80" y="46" width="58" height="8" rx="4" fill="currentColor" opacity="0.18" />
      </g>
    ))}
  </svg>
)

/** Offline state: a cloud with a disconnected/paper-plane path. */
export const Offline: IllustrationComponent = (p) => (
  <svg {...base(p)}>
    <path
      d="M60 88a24 24 0 0 1-4-47.6A30 30 0 0 1 114 30a22 22 0 0 1 26 21.6A20 20 0 0 1 136 88Z"
      fill="currentColor"
      opacity="0.12"
    />
    <path
      d="M60 88a24 24 0 0 1-4-47.6A30 30 0 0 1 114 30a22 22 0 0 1 26 21.6A20 20 0 0 1 136 88Z"
      stroke="currentColor"
      strokeWidth="2"
      opacity="0.5"
    />
    <path d="M74 104l52-32" stroke="#e8593a" strokeWidth="3" strokeLinecap="round" />
    <path d="M126 72l52 32" stroke="#e8593a" strokeWidth="3" strokeLinecap="round" />
  </svg>
)

/** Generic error fallback: a gently-tipped compass (lost, not broken). */
export const ErrorState: IllustrationComponent = (p) => (
  <svg {...base(p)}>
    <circle cx="100" cy="70" r="42" fill="currentColor" opacity="0.06" />
    <circle cx="100" cy="70" r="42" stroke="currentColor" strokeWidth="2.4" opacity="0.5" transform="rotate(-8 100 70)" />
    <path d="M114 54l-8 24-24 8 8-24z" fill="#e8593a" transform="rotate(-8 100 70)" />
    <circle cx="100" cy="70" r="4" fill="currentColor" />
  </svg>
)

export const ILLUSTRATION_REGISTRY = {
  'empty-plan': EmptyPlan,
  'no-expenses': NoExpenses,
  'all-settled': AllSettled,
  'retro-header': RetroHeader,
  'join-cover': JoinCover,
  'nothing-to-decide': NothingToDecide,
  offline: Offline,
  error: ErrorState,
} as const satisfies Record<string, IllustrationComponent>

export type IllustrationName = keyof typeof ILLUSTRATION_REGISTRY
