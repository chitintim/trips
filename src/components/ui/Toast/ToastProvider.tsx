import { createContext, useCallback, useContext, useState, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Toast, ToastProps } from './Toast'

export interface ToastOptions {
  type?: ToastProps['type']
  message: string
  description?: string
  duration?: number
}

interface ToastContextValue {
  showToast: (options: ToastOptions) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

interface ToastEntry extends ToastOptions {
  id: string
}

/**
 * App-wide toast host. Mount once near the root (App.tsx). Any component
 * can call `useToast().showToast(...)` to surface a transient
 * success/error/warning/info message; `useToastOnError` (see
 * useToastOnError.ts) wraps this for the common "show an error toast when
 * a mutation fails" pattern.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([])

  const showToast = useCallback((options: ToastOptions) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setToasts((prev) => [...prev, { id, duration: 5000, ...options }])
  }, [])

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {createPortal(
        <div
          className="fixed bottom-4 right-4 left-4 sm:left-auto z-toast flex flex-col gap-2 sm:max-w-sm pointer-events-none"
          aria-live="polite"
        >
          {toasts.map((t) => (
            <div key={t.id} className="pointer-events-auto">
              <Toast
                type={t.type}
                message={t.message}
                description={t.description}
                duration={t.duration}
                onClose={() => dismiss(t.id)}
              />
            </div>
          ))}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return ctx
}
