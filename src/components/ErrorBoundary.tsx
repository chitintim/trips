import { Component, ErrorInfo, ReactNode } from 'react'
import { Button, Card, EmptyState } from './ui'
import { ErrorState } from './ui/illustrations'
import { reportError } from '../lib/reportError'

export interface ErrorBoundaryProps {
  /**
   * Content to protect. On error, this subtree is unmounted and replaced
   * by the fallback until the user retries.
   */
  children: ReactNode

  /**
   * Label shown in the fallback message, e.g. "Expenses" so the message
   * reads "Something went wrong loading Expenses." Defaults to "this tab".
   */
  label?: string

  /**
   * Optional extra local handler, called alongside the automatic
   * reportError('error-boundary', ...) telemetry in componentDidCatch
   * below -- e.g. if a tab wants to also reset some local state. Every
   * caught error is reported regardless of whether this is passed.
   */
  onError?: (error: Error, info: ErrorInfo) => void
}

interface ErrorBoundaryState {
  error: Error | null
}

// Browsers word "the dynamically-imported chunk isn't there" differently --
// Chrome/Vite: "Failed to fetch dynamically imported module"; Firefox:
// "error loading dynamically imported module"; Safari: "Importing a module
// script failed". All three show up when GitHub Pages' atomic dist/
// replacement (see .github/workflows/deploy.yml) has retired a hashed chunk
// a still-open tab is asking for -- the SPA 404 fallback answers with HTML
// instead of JS. That's not "something went wrong", it's "reload to update".
const CHUNK_LOAD_ERROR_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
]

function isChunkLoadError(error: Error): boolean {
  return CHUNK_LOAD_ERROR_PATTERNS.some((pattern) => pattern.test(error.message))
}

/**
 * Per-tab error boundary (per UPGRADE_MASTER_PLAN §4/§16: "error boundaries
 * per tab"). Wrap each TripDetail tab's content independently so a bug in,
 * say, the Expenses tab doesn't take down navigation, the header, or
 * other tabs — the user sees a friendly fallback with a retry button that
 * remounts just that subtree.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, info)
    reportError(error, 'error-boundary')
    this.props.onError?.(error, info)
  }

  handleRetry = () => {
    this.setState({ error: null })
  }

  render() {
    if (this.state.error) {
      if (isChunkLoadError(this.state.error)) {
        return (
          <Card className="max-w-lg mx-auto">
            <Card.Content className="py-10">
              <EmptyState
                icon={<ErrorState className="w-24 h-24 text-danger-500" />}
                title="A new version of Tim's Trip Planner was deployed"
                description="Reload the page to pick up the update."
                action={
                  <Button variant="primary" onClick={() => window.location.reload()}>
                    Reload
                  </Button>
                }
              />
            </Card.Content>
          </Card>
        )
      }

      const label = this.props.label || 'this section'
      return (
        <Card className="max-w-lg mx-auto">
          <Card.Content className="py-10">
            <EmptyState
              icon={<ErrorState className="w-24 h-24 text-danger-500" />}
              title={`Something went wrong loading ${label}`}
              description={
                this.state.error.message || 'An unexpected error occurred. You can try again, or refresh the page.'
              }
              action={
                <Button variant="primary" onClick={this.handleRetry}>
                  Try again
                </Button>
              }
            />
          </Card.Content>
        </Card>
      )
    }

    return this.props.children
  }
}
