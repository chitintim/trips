/**
 * Design Tokens - Winter Clean Theme
 *
 * A winter-inspired design system featuring cool blues with vibrant orange accents.
 * Perfect for a ski trip planning application.
 *
 * Primary: Tints of blue (winter sky, snow, ice)
 * Accent: Vibrant orange (ski jackets, sunset on snow, warmth)
 * Neutral: Cool grays (professional, clean)
 */

// ============================================================================
// COLORS
// ============================================================================

export const colors = {
  // Primary - Blue scale (main brand color)
  primary: {
    50: '#f0f9ff',   // Lightest blue - backgrounds
    100: '#e0f2fe',  // Very light blue - hover states
    200: '#bae6fd',  // Light blue - subtle highlights
    300: '#7dd3fc',  // Medium-light blue
    400: '#38bdf8',  // Medium blue
    500: '#0ea5e9',  // Primary action color - clear winter sky
    600: '#0284c7',  // Darker blue - hover/active states
    700: '#0369a1',  // Dark blue - pressed states
    800: '#075985',  // Very dark blue
    900: '#0c4a6e',  // Darkest blue - text on light backgrounds
    950: '#082f49',  // Nearly black blue
  },

  // Secondary/Accent - Orange scale (warmth, energy, contrast)
  secondary: {
    50: '#fff7ed',   // Lightest orange
    100: '#ffedd5',  // Very light orange
    200: '#fed7aa',  // Light orange
    300: '#fdba74',  // Medium-light orange
    400: '#fb923c',  // Medium orange
    500: '#f97316',  // Primary accent color - vibrant, energetic
    600: '#ea580c',  // Darker orange - hover states
    700: '#c2410c',  // Dark orange
    800: '#9a3412',  // Very dark orange
    900: '#7c2d12',  // Darkest orange
    950: '#431407',  // Nearly black orange
  },

  // Neutral - Cool gray scale (text, borders, backgrounds)
  neutral: {
    50: '#f8fafc',   // Off-white - page backgrounds
    100: '#f1f5f9',  // Very light gray - card backgrounds
    200: '#e2e8f0',  // Light gray - borders
    300: '#cbd5e1',  // Medium-light gray - disabled states
    400: '#94a3b8',  // Medium gray - placeholder text
    500: '#64748b',  // Medium-dark gray - secondary text
    600: '#475569',  // Dark gray - body text
    700: '#334155',  // Darker gray - headings
    800: '#1e293b',  // Very dark gray - important text
    900: '#0f172a',  // Nearly black - primary text
    950: '#020617',  // True black
  },

  // Semantic colors
  success: {
    50: '#f0fdf4',
    100: '#dcfce7',
    500: '#10b981',  // Green - success states
    600: '#059669',
    700: '#047857',
    900: '#064e3b',
  },

  error: {
    50: '#fef2f2',
    100: '#fee2e2',
    500: '#ef4444',  // Red - error states
    600: '#dc2626',
    700: '#b91c1c',
    900: '#7f1d1d',
  },

  warning: {
    50: '#fefce8',
    100: '#fef9c3',
    500: '#eab308',  // Yellow - warning states
    600: '#ca8a04',
    700: '#a16207',
    900: '#713f12',
  },

  info: {
    50: '#eff6ff',
    100: '#dbeafe',
    500: '#3b82f6',  // Blue - info states
    600: '#2563eb',
    700: '#1d4ed8',
    900: '#1e3a8a',
  },

  // Additional utility colors
  white: '#ffffff',
  black: '#000000',
  transparent: 'transparent',
} as const

// ============================================================================
// TYPOGRAPHY
// ============================================================================

export const typography = {
  fontFamily: {
    sans: [
      'Inter',
      '-apple-system',
      'BlinkMacSystemFont',
      '"Segoe UI"',
      'Roboto',
      '"Helvetica Neue"',
      'Arial',
      'sans-serif',
    ].join(', '),
    mono: [
      '"SF Mono"',
      'Monaco',
      'Inconsolata',
      '"Roboto Mono"',
      'monospace',
    ].join(', '),
  },

  fontSize: {
    xs: ['0.75rem', { lineHeight: '1rem' }],      // 12px
    sm: ['0.875rem', { lineHeight: '1.25rem' }],  // 14px
    base: ['1rem', { lineHeight: '1.5rem' }],     // 16px (body text)
    lg: ['1.125rem', { lineHeight: '1.75rem' }],  // 18px
    xl: ['1.25rem', { lineHeight: '1.75rem' }],   // 20px
    '2xl': ['1.5rem', { lineHeight: '2rem' }],    // 24px
    '3xl': ['1.875rem', { lineHeight: '2.25rem' }], // 30px
    '4xl': ['2.25rem', { lineHeight: '2.5rem' }],   // 36px (page titles)
    '5xl': ['3rem', { lineHeight: '1' }],           // 48px
  },

  fontWeight: {
    normal: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },

  lineHeight: {
    tight: '1.25',
    normal: '1.5',
    relaxed: '1.75',
  },

  letterSpacing: {
    tight: '-0.01em',
    normal: '0',
    wide: '0.01em',
  },
} as const

// ============================================================================
// SPACING
// ============================================================================

export const spacing = {
  0: '0',
  px: '1px',
  0.5: '0.125rem',  // 2px
  1: '0.25rem',     // 4px
  1.5: '0.375rem',  // 6px
  2: '0.5rem',      // 8px
  2.5: '0.625rem',  // 10px
  3: '0.75rem',     // 12px
  3.5: '0.875rem',  // 14px
  4: '1rem',        // 16px
  5: '1.25rem',     // 20px
  6: '1.5rem',      // 24px
  7: '1.75rem',     // 28px
  8: '2rem',        // 32px
  9: '2.25rem',     // 36px
  10: '2.5rem',     // 40px
  12: '3rem',       // 48px
  14: '3.5rem',     // 56px
  16: '4rem',       // 64px
  20: '5rem',       // 80px
  24: '6rem',       // 96px
  32: '8rem',       // 128px
} as const

// ============================================================================
// BORDER RADIUS
// ============================================================================

export const borderRadius = {
  none: '0',
  sm: '0.125rem',   // 2px
  base: '0.25rem',  // 4px (default)
  md: '0.375rem',   // 6px
  lg: '0.5rem',     // 8px (cards)
  xl: '0.75rem',    // 12px
  '2xl': '1rem',    // 16px
  '3xl': '1.5rem',  // 24px
  full: '9999px',   // Pills, avatars
} as const

// ============================================================================
// SHADOWS
// ============================================================================

export const shadows = {
  sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  base: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  lg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  xl: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
  '2xl': '0 25px 50px -12px rgb(0 0 0 / 0.25)',
  inner: 'inset 0 2px 4px 0 rgb(0 0 0 / 0.05)',
  none: 'none',
} as const

// ============================================================================
// BREAKPOINTS (Mobile-first)
// ============================================================================

export const breakpoints = {
  sm: '640px',   // Small tablets
  md: '768px',   // Tablets
  lg: '1024px',  // Small laptops
  xl: '1280px',  // Desktops
  '2xl': '1536px', // Large desktops
} as const

// ============================================================================
// Z-INDEX SCALE
// ============================================================================

export const zIndex = {
  0: '0',
  10: '10',
  20: '20',
  30: '30',
  40: '40',
  50: '50',
  dropdown: '1000',
  sticky: '1100',
  modal: '1200',
  popover: '1300',
  tooltip: '1400',
  toast: '1500',
} as const

// ============================================================================
// TRANSITIONS
// ============================================================================

export const transitions = {
  duration: {
    fast: '150ms',
    base: '200ms',
    slow: '300ms',
    slower: '500ms',
  },
  timing: {
    linear: 'linear',
    easeIn: 'cubic-bezier(0.4, 0, 1, 1)',
    easeOut: 'cubic-bezier(0, 0, 0.2, 1)',
    easeInOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
} as const

// ============================================================================
// COMPONENT-SPECIFIC TOKENS
// ============================================================================

export const components = {
  button: {
    height: {
      sm: spacing[8],   // 32px
      md: spacing[10],  // 40px
      lg: spacing[12],  // 48px
    },
    padding: {
      sm: `${spacing[2]} ${spacing[3]}`,   // 8px 12px
      md: `${spacing[2.5]} ${spacing[4]}`, // 10px 16px
      lg: `${spacing[3]} ${spacing[6]}`,   // 12px 24px
    },
  },
  input: {
    height: {
      sm: spacing[8],   // 32px
      md: spacing[10],  // 40px
      lg: spacing[12],  // 48px
    },
  },
  card: {
    padding: spacing[6],  // 24px
    borderRadius: borderRadius.lg,
  },
  modal: {
    maxWidth: {
      sm: '400px',
      md: '600px',
      lg: '800px',
      xl: '1000px',
    },
  },
} as const

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type Color = keyof typeof colors
export type ColorShade = keyof typeof colors.primary
export type FontSize = keyof typeof typography.fontSize
export type FontWeight = keyof typeof typography.fontWeight
export type Spacing = keyof typeof spacing
export type BorderRadius = keyof typeof borderRadius
export type Shadow = keyof typeof shadows
export type Breakpoint = keyof typeof breakpoints
export type ZIndex = keyof typeof zIndex
