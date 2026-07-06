import { useToast } from '../../components/ui'

/**
 * Convention for surfacing mutation failures: pass the returned function as
 * a `useMutation({ onError })` handler (or call it directly in a catch
 * block) to show a consistent error toast instead of `alert(...)` /
 * silent console.error, which is what most of the legacy components do
 * today.
 *
 * Usage:
 *   const onMutationError = useToastOnError('Failed to save expense')
 *   const mutation = useMutation({ mutationFn, onError: onMutationError })
 */
export function useToastOnError(fallbackMessage = 'Something went wrong') {
  const { showToast } = useToast()

  return (error: unknown) => {
    const message = error instanceof Error ? error.message : fallbackMessage
    showToast({ type: 'error', message: fallbackMessage, description: message !== fallbackMessage ? message : undefined })
  }
}
