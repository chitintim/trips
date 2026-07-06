import { Component, ErrorInfo, ReactNode } from 'react'
import { Button, Card, EmptyState } from './ui'

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
   * Optional extra reporting hook (e.g. wiring to Sentry later) — called
   * with the error and component stack. Intentionally not implemented
   * here; Sentry itself is out of scope per the workstream brief.
   */
  onError?: (error: Error, info: ErrorInfo) => void
}

interface ErrorBoundaryState {
  error: Error | null
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
    this.props.onError?.(error, info)
  }

  handleRetry = () => {
    this.setState({ error: null })
  }

  render() {
    if (this.state.error) {
      const label = this.props.label || 'this section'
      return (
        <Card className="max-w-lg mx-auto">
          <Card.Content className="py-10">
            <EmptyState
              icon="⚠️"
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
