import { AVATAR_BG_COLORS } from '../types'
import { ICON_REGISTRY, AVATAR_ICON_NAMES, type AvatarIconName } from './ui/Avatar'

interface AvatarIconPickerProps {
  icon: AvatarIconName
  bgColor: string
  onChange: (next: { icon: AvatarIconName; bgColor: string }) => void
  disabled?: boolean
}

/**
 * Avatar system v2 "Icons" tab (UX_REDESIGN.md "Avatar system v2" (b)/(d)):
 * grid of the ~28 travel-themed SVG icons x the existing curated background
 * color palette (reusing AVATAR_BG_COLORS from the legacy emoji builder so
 * the two tabs share one set of "on-brand" colors).
 */
export function AvatarIconPicker({ icon, bgColor, onChange, disabled }: AvatarIconPickerProps) {
  return (
    <div className="space-y-4">
      {/* Preview */}
      <div className="flex justify-center">
        <div
          className="w-24 h-24 rounded-full flex items-center justify-center transition-colors duration-200"
          style={{ backgroundColor: bgColor }}
        >
          {(() => {
            const Icon = ICON_REGISTRY[icon]
            return <Icon className="w-12 h-12 text-white" />
          })()}
        </div>
      </div>

      {/* Icon grid */}
      <div>
        <label className="block text-xs font-medium text-[var(--text-secondary)] mb-2">Icon</label>
        <div className="grid grid-cols-6 gap-2 max-h-56 overflow-y-auto">
          {AVATAR_ICON_NAMES.map((name) => {
            const Icon = ICON_REGISTRY[name]
            const isSelected = name === icon
            return (
              <button
                key={name}
                type="button"
                onClick={() => onChange({ icon: name, bgColor })}
                disabled={disabled}
                title={name.replace(/-/g, ' ')}
                aria-label={name.replace(/-/g, ' ')}
                aria-pressed={isSelected}
                className={`
                  w-full aspect-square rounded-[var(--radius-md)] flex items-center justify-center
                  transition-all duration-150
                  ${isSelected
                    ? 'bg-accent-100 border-2 border-accent-500 scale-110 dark:bg-accent-950'
                    : 'bg-[var(--surface-sunken)] border-2 border-transparent hover:border-accent-300 hover:scale-105'
                  }
                  ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                `}
              >
                <Icon className="w-5 h-5 text-[var(--text-primary)]" />
              </button>
            )
          })}
        </div>
      </div>

      {/* Background color */}
      <div>
        <label className="block text-xs font-medium text-[var(--text-secondary)] mb-2">Background color</label>
        <div className="grid grid-cols-4 gap-2">
          {AVATAR_BG_COLORS.map((color) => (
            <button
              key={color.value}
              type="button"
              onClick={() => onChange({ icon, bgColor: color.value })}
              disabled={disabled}
              aria-label={color.label}
              aria-pressed={bgColor === color.value}
              className={`
                p-2 rounded-[var(--radius-md)] flex flex-col items-center justify-center gap-1.5
                transition-all duration-150 border-2
                ${bgColor === color.value ? 'border-[var(--text-primary)] scale-105' : 'border-transparent hover:border-[var(--border-default)] hover:scale-105'}
                ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
              `}
            >
              <div className="w-8 h-8 rounded-full" style={{ backgroundColor: color.preview }} />
              <span className="text-[10px] text-[var(--text-secondary)] font-medium">{color.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
