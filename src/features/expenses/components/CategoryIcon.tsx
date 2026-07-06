import { categoryIcon, categoryLabel } from '../lib/categoryStyle'

export function CategoryIcon({ category, className = '' }: { category: string | null | undefined; className?: string }) {
  return (
    <span
      role="img"
      aria-label={categoryLabel(category)}
      className={`inline-flex items-center justify-center text-lg leading-none ${className}`.trim()}
    >
      {categoryIcon(category)}
    </span>
  )
}
