import { useEffect, useRef, useState } from 'react'
import { Modal, Button, Input, SegmentedControl, Spinner } from '../../../components/ui'
import { useCreatePlace, useUpdatePlace } from '../../../lib/queries'
import { parseGoogleMapsLink } from '../../../lib/places/parseGoogleMapsLink'
import { searchPlace, type GeocodeResult } from '../../../lib/places/geocode'
import type { Tables } from '../../../types/database.types'

export interface PlacePickerProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  /** Called with the created/updated place once the user picks/confirms one. */
  onPicked: (place: Tables<'places'>) => void
  title?: string
  /**
   * When provided, the picker updates this existing place's coordinates
   * instead of creating a new place row, so re-picking a name-only place
   * doesn't create a duplicate. Originally wired for the legacy
   * TripMapTab's "places with no coordinates" geocode-fix list (removed as
   * unreachable dead code, UPGRADE_MASTER_PLAN.md audit item 7); now used
   * by the Plan Map lens's "N places aren't on the map yet" section
   * (PlanMapLens.tsx's UnpinnedPlacesSection) for the same fix-up flow.
   */
  existingPlace?: Tables<'places'>
}

type Mode = 'link' | 'search' | 'manual'

const SEARCH_DEBOUNCE_MS = 400

/**
 * Sheet for attaching a place to any entity (option, timeline event,
 * expense). Three ways in:
 *  - Paste a Google Maps link (live parse feedback, handles short links by
 *    asking for the expanded URL)
 *  - Search by name (Nominatim, debounced)
 *  - Manual name-only fallback (no coordinates — attaches fine, just
 *    without a map pin)
 * Ends by creating (or, with `existingPlace`, updating — see its doc)
 * a row and returning it via onPicked.
 */
export function PlacePicker({ isOpen, onClose, tripId, onPicked, title = 'Add a place', existingPlace }: PlacePickerProps) {
  const [mode, setMode] = useState<Mode>('link')
  const [linkValue, setLinkValue] = useState('')
  const [searchValue, setSearchValue] = useState('')
  const [manualName, setManualName] = useState(existingPlace?.name ?? '')
  const [searchResults, setSearchResults] = useState<GeocodeResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const createPlace = useCreatePlace(tripId)
  const updatePlace = useUpdatePlace(tripId)

  const linkResult = linkValue.trim() ? parseGoogleMapsLink(linkValue) : null

  // Reset local state whenever the sheet is (re)opened for a fresh pick.
  useEffect(() => {
    if (isOpen) {
      setMode(existingPlace ? 'search' : 'link')
      setLinkValue('')
      setSearchValue(existingPlace?.name ?? '')
      setManualName(existingPlace?.name ?? '')
      setSearchResults([])
      setSearched(false)
      setError(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  useEffect(() => {
    if (mode !== 'search') return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const query = searchValue.trim()
    if (!query) {
      setSearchResults([])
      setSearched(false)
      return
    }
    setSearching(true)
    debounceRef.current = setTimeout(async () => {
      const results = await searchPlace(query)
      setSearchResults(results)
      setSearching(false)
      setSearched(true)
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [searchValue, mode])

  async function createAndPick(input: Omit<Tables<'places'>, 'id' | 'created_at' | 'trip_id'>) {
    setSubmitting(true)
    setError(null)
    try {
      if (existingPlace) {
        await updatePlace.mutateAsync({ id: existingPlace.id, update: input })
        onPicked({ ...existingPlace, ...input })
      } else {
        const place = await createPlace.mutateAsync(input)
        onPicked(place)
      }
      onClose()
    } catch {
      setError('Could not save this place. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleUseLink() {
    if (!linkResult || linkResult.needsResolution) return
    await createAndPick({
      name: linkResult.name || linkValue.trim(),
      lat: linkResult.lat,
      lng: linkResult.lng,
      google_maps_link: linkValue.trim(),
      google_place_url: linkValue.trim(),
      address: null,
      source: 'link_parse',
    })
  }

  async function handlePickSearchResult(result: GeocodeResult) {
    await createAndPick({
      name: result.name,
      lat: result.lat,
      lng: result.lng,
      address: result.address,
      google_maps_link: null,
      google_place_url: null,
      source: 'manual',
    })
  }

  async function handleManualSubmit() {
    const name = manualName.trim()
    if (!name) return
    await createAndPick({
      name,
      lat: null,
      lng: null,
      address: null,
      google_maps_link: null,
      google_place_url: null,
      source: 'manual',
    })
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="md">
      <div className="space-y-4">
        <div className="border-b border-[var(--border-subtle)] pb-3">
          <SegmentedControl
            fullWidth
            value={mode}
            onChange={setMode}
            options={[
              { value: 'link', label: 'Paste a link' },
              { value: 'search', label: 'Search by name' },
              { value: 'manual', label: 'Name only' },
            ]}
          />
        </div>

        {mode === 'link' && (
          <div className="space-y-3">
            <Input
              label="Google Maps link"
              placeholder="https://maps.google.com/... or https://maps.app.goo.gl/..."
              value={linkValue}
              onChange={(e) => setLinkValue(e.target.value)}
              autoFocus
            />
            {linkResult && linkValue.trim() && (
              <div
                className={`rounded-[var(--radius-md)] border p-3 text-sm ${
                  linkResult.needsResolution
                    ? 'border-warn-300 bg-warn-50 text-warn-800'
                    : linkResult.lat != null
                      ? 'border-success-300 bg-success-50 text-success-800'
                      : 'border-[var(--border-default)] bg-[var(--surface-sunken)] text-[var(--text-secondary)]'
                }`}
              >
                {linkResult.needsResolution ? (
                  <p>{linkResult.reason}</p>
                ) : linkResult.lat != null ? (
                  <p>
                    Found <strong>{linkResult.name || 'this place'}</strong> at {linkResult.lat.toFixed(5)},{' '}
                    {linkResult.lng!.toFixed(5)}
                  </p>
                ) : linkResult.name ? (
                  <p>
                    Found the name <strong>{linkResult.name}</strong> but no coordinates — we'll save it and you can
                    pin it later, or try "Search by name" instead.
                  </p>
                ) : (
                  <p>{linkResult.reason}</p>
                )}
              </div>
            )}
            <Button
              variant="primary"
              fullWidth
              disabled={!linkResult || linkResult.needsResolution || submitting}
              isLoading={submitting}
              onClick={handleUseLink}
            >
              Use this place
            </Button>
          </div>
        )}

        {mode === 'search' && (
          <div className="space-y-3">
            <Input
              label="Place or vendor name"
              placeholder="e.g. Tsukiji Outer Market"
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              autoFocus
            />
            {searching && (
              <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                <Spinner size="sm" /> Searching…
              </div>
            )}
            {!searching && searched && searchResults.length === 0 && (
              <p className="text-sm text-[var(--text-muted)]">
                No matches found. Try a different spelling, or use "Name only" below.
              </p>
            )}
            {!searching && searchResults.length > 0 && (
              <ul className="space-y-1.5 max-h-64 overflow-y-auto">
                {searchResults.map((result, i) => (
                  <li key={`${result.lat}-${result.lng}-${i}`}>
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => handlePickSearchResult(result)}
                      className="w-full text-left rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-3 text-sm hover:border-accent-400 hover:bg-accent-50 dark:hover:bg-accent-950 transition-colors disabled:opacity-50"
                    >
                      <div className="font-medium text-[var(--text-primary)]">{result.name}</div>
                      {result.address && (
                        <div className="text-xs text-[var(--text-muted)] truncate">{result.address}</div>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {mode === 'manual' && (
          <div className="space-y-3">
            <Input
              label="Place name"
              placeholder="e.g. Grandma's chalet"
              value={manualName}
              onChange={(e) => setManualName(e.target.value)}
              helperText='No map coordinates — it still attaches to this item, just without a pin. For a pin, try "Search by name" instead.'
              autoFocus
            />
            <Button variant="primary" fullWidth disabled={!manualName.trim() || submitting} isLoading={submitting} onClick={handleManualSubmit}>
              Save name-only place
            </Button>
          </div>
        )}

        {error && <p className="text-sm text-danger-600">{error}</p>}
      </div>
    </Modal>
  )
}
