import { ReactNode } from 'react'

interface AuthLayoutProps {
  title: string
  subtitle?: string
  children: ReactNode
}

/**
 * Shared shell for every auth screen (login, signup, forgot/reset password).
 * Mobile-first, warm-neutral, single accent — matches the v2 design
 * language (src/index.css tokens) rather than the legacy sky/orange
 * gradient.
 */
export function AuthLayout({ title, subtitle, children }: AuthLayoutProps) {
  return (
    <div className="min-h-screen bg-[var(--surface-page)] flex flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-[var(--radius-lg)] bg-accent-600 text-2xl mb-4">
            🧳
          </div>
          <h1 className="text-2xl font-semibold text-[var(--text-primary)]">{title}</h1>
          {subtitle && <p className="text-sm text-[var(--text-secondary)] mt-1.5">{subtitle}</p>}
        </div>
        {children}
      </div>
    </div>
  )
}
