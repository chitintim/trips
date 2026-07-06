/**
 * Small SVG ring showing % of an itemized receipt's items claimed. Used on
 * expense cards (plan §10 "claim-status ring for itemized"). Hand-rolled
 * SVG, no chart library (per plan §7/§10 "no heavy chart lib").
 */
export interface ClaimStatusRingProps {
  /** 0-100 */
  percentClaimed: number
  size?: number
  className?: string
}

export function ClaimStatusRing({ percentClaimed, size = 28, className = '' }: ClaimStatusRingProps) {
  const clamped = Math.max(0, Math.min(100, percentClaimed))
  const strokeWidth = 3
  const radius = size / 2 - strokeWidth
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - clamped / 100)
  const isFull = clamped >= 99.9

  const color = isFull ? 'var(--color-success-500, #22c55e)' : 'var(--color-accent-500, #6366f1)'

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      role="img"
      aria-label={isFull ? 'Fully claimed' : `${Math.round(clamped)}% claimed`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--border-subtle, #e5e7eb)"
        strokeWidth={strokeWidth}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 0.3s ease-out' }}
      />
      {isFull && (
        <path
          d={`M ${size * 0.32} ${size * 0.52} L ${size * 0.44} ${size * 0.64} L ${size * 0.68} ${size * 0.36}`}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth - 0.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  )
}
