// On phones toasts sit at the top (below the notch) so they never cover a
// sheet's Cancel/Save buttons; from sm: up they keep the bottom-right corner.
export const TOAST_CONTAINER_CLASSES =
  'fixed left-4 right-4 top-[calc(env(safe-area-inset-top)+0.75rem)] sm:top-auto sm:bottom-4 sm:left-auto sm:right-4 z-toast flex flex-col gap-2 sm:max-w-sm pointer-events-none'

// Slides down from the top on phones, up from the bottom on desktop.
export const TOAST_ANIMATION_CLASSES =
  'animate-[fable-toast-in-top_0.2s_ease-out] sm:animate-[fable-toast-in_0.2s_ease-out]'
