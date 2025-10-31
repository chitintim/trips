import { AvatarData, AVATAR_EMOJIS, AVATAR_ACCESSORIES, AVATAR_BG_COLORS } from '../types'

interface AvatarBuilderProps {
  value: AvatarData
  onChange: (data: AvatarData) => void
  disabled?: boolean
}

export function AvatarBuilder({ value, onChange, disabled }: AvatarBuilderProps) {
  return (
    <div className="space-y-4">
      {/* Preview */}
      <div className="flex justify-center">
        <div
          className="w-24 h-24 rounded-full flex items-center justify-center text-4xl relative transition-colors duration-200"
          style={{ backgroundColor: value.bgColor }}
        >
          <span className="relative">
            {value.emoji}
            {value.accessory && (
              <span className="absolute -top-2 -right-2 text-2xl">
                {value.accessory}
              </span>
            )}
          </span>
        </div>
      </div>

      {/* Base Emoji Selector */}
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-2">
          Face
        </label>
        <div className="grid grid-cols-6 gap-2">
          {AVATAR_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onChange({ ...value, emoji })}
              disabled={disabled}
              className={`
                w-full aspect-square rounded-lg text-2xl flex items-center justify-center
                transition-all duration-200
                ${value.emoji === emoji
                  ? 'bg-sky-100 border-2 border-sky-500 scale-110'
                  : 'bg-white border-2 border-gray-200 hover:border-sky-300 hover:scale-105'
                }
                ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
              `}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>

      {/* Accessory Selector */}
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-2">
          Accessory (Optional)
        </label>
        <div className="grid grid-cols-4 gap-2">
          {AVATAR_ACCESSORIES.map((accessory) => (
            <button
              key={accessory.label}
              type="button"
              onClick={() => onChange({ ...value, accessory: accessory.value })}
              disabled={disabled}
              className={`
                p-3 rounded-lg text-xl flex flex-col items-center justify-center gap-1
                transition-all duration-200
                ${value.accessory === accessory.value
                  ? 'bg-sky-100 border-2 border-sky-500 scale-105'
                  : 'bg-white border-2 border-gray-200 hover:border-sky-300 hover:scale-105'
                }
                ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
              `}
            >
              {accessory.emoji || '—'}
              <span className="text-[10px] text-gray-600 font-medium">
                {accessory.label}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Background Color Selector */}
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-2">
          Background Color
        </label>
        <div className="grid grid-cols-4 gap-2">
          {AVATAR_BG_COLORS.map((color) => (
            <button
              key={color.value}
              type="button"
              onClick={() => onChange({ ...value, bgColor: color.value })}
              disabled={disabled}
              className={`
                p-2 rounded-lg flex flex-col items-center justify-center gap-1.5
                transition-all duration-200 border-2
                ${value.bgColor === color.value
                  ? 'border-gray-900 scale-105'
                  : 'border-gray-200 hover:border-gray-400 hover:scale-105'
                }
                ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
              `}
            >
              <div
                className="w-8 h-8 rounded-full"
                style={{ backgroundColor: color.preview }}
              />
              <span className="text-[10px] text-gray-600 font-medium">
                {color.label}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
