/**
 * PlanningTabV2 - Enhanced planning tab with:
 * - Matrix/Grid view for equipment rentals
 * - Quick Add Options for bulk creation
 * - Improved admin workflows
 *
 * This is a PROTOTYPE - do not commit to production yet
 */

import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../hooks/useAuth'
import { Button, Card, Badge, Spinner, EmptyState, SelectionAvatars } from '../ui'
import { CreatePlanningSectionModal } from '../CreatePlanningSectionModal'
import { CreateOptionModal } from '../CreateOptionModal'
import { MatrixSelector } from './MatrixSelector'
import { QuickAddOptions } from './QuickAddOptions'
import { Trip, User, TripParticipant } from '../../types'
import { isTripLocked } from '../../lib/tripStatus'

interface ParticipantWithUser extends TripParticipant {
  user: User
}

interface PlanningTabV2Props {
  trip: Trip
  participants: ParticipantWithUser[]
}

export function PlanningTabV2({ trip, participants }: PlanningTabV2Props) {
  const { user } = useAuth()
  const [isAdmin, setIsAdmin] = useState(false)
  const [sections, setSections] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [createSectionModalOpen, setCreateSectionModalOpen] = useState(false)
  const [createOptionModalOpen, setCreateOptionModalOpen] = useState(false)
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null)
  const [editingOption, setEditingOption] = useState<any | null>(null)
  const [editingSection, setEditingSection] = useState<any | null>(null)

  useEffect(() => {
    checkAdminStatus()
  }, [trip.id, user])

  useEffect(() => {
    fetchPlanningSections()
  }, [trip.id])

  const checkAdminStatus = async () => {
    if (!user) return

    const { data: userData } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    const isSystemAdmin = userData?.role === 'admin'

    const { data: participantData } = await supabase
      .from('trip_participants')
      .select('role')
      .eq('trip_id', trip.id)
      .eq('user_id', user.id)
      .single()

    const isTripOrganizer = participantData?.role === 'organizer'
    const isTripCreator = trip.created_by === user.id

    setIsAdmin(isSystemAdmin || isTripCreator || isTripOrganizer)
  }

  const fetchPlanningSections = async () => {
    setLoading(true)

    const { data: sectionsData, error } = await supabase
      .from('planning_sections')
      .select(`
        *,
        options (
          *,
          selections (
            *,
            user:user_id (*)
          )
        )
      `)
      .eq('trip_id', trip.id)
      .order('order_index', { ascending: true })

    if (!error && sectionsData) {
      const sortedSections = [...sectionsData].sort((a, b) => {
        const statusOrder: { [key: string]: number } = {
          'in_progress': 1,
          'not_started': 2,
          'completed': 3
        }
        const orderA = statusOrder[a.status] || 4
        const orderB = statusOrder[b.status] || 4

        if (orderA === orderB) {
          return (a.order_index || 0) - (b.order_index || 0)
        }

        return orderA - orderB
      })

      setSections(sortedSections)
    }

    setLoading(false)
  }

  const handleCreateOption = (sectionId: string, option?: any) => {
    setSelectedSectionId(sectionId)
    setEditingOption(option || null)
    setCreateOptionModalOpen(true)
  }

  // Optimistic update for selections
  const handleSelectionUpdate = (sectionId: string, optionId: string, userId: string, action: 'add' | 'remove', newSelection?: any) => {
    setSections(prevSections => {
      return prevSections.map(section => {
        if (section.id !== sectionId) return section

        return {
          ...section,
          options: section.options.map((option: any) => {
            if (action === 'remove' && option.id === optionId) {
              return {
                ...option,
                selections: option.selections.filter((s: any) => s.user_id !== userId)
              }
            }

            if (action === 'add') {
              if (!section.allow_multiple_selections && option.id !== optionId) {
                return {
                  ...option,
                  selections: option.selections.filter((s: any) => s.user_id !== userId)
                }
              }

              if (option.id === optionId && newSelection) {
                return {
                  ...option,
                  selections: [...option.selections, newSelection]
                }
              }
            }

            return option
          })
        }
      })
    })
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    )
  }

  if (sections.length === 0) {
    return (
      <>
        <Card>
          <Card.Content className="py-12">
            <EmptyState
              icon="📋"
              title="No planning sections yet"
              description={isAdmin ? "Start by creating planning sections like Accommodation, Flights, or Transport." : "The trip organizer will add planning sections soon."}
              action={
                isAdmin ? (
                  <Button
                    variant="primary"
                    onClick={() => setCreateSectionModalOpen(true)}
                  >
                    + Create Section
                  </Button>
                ) : undefined
              }
            />
          </Card.Content>
        </Card>

        <CreatePlanningSectionModal
          isOpen={createSectionModalOpen}
          onClose={() => {
            setCreateSectionModalOpen(false)
            setEditingSection(null)
          }}
          tripId={trip.id}
          onSuccess={fetchPlanningSections}
          section={editingSection}
        />
      </>
    )
  }

  return (
    <>
      <div className="space-y-4">
        {/* Header with Create Section Button */}
        {isAdmin && (
          <div className="flex justify-end">
            <Button
              variant="primary"
              onClick={() => setCreateSectionModalOpen(true)}
            >
              + Create Section
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-4">
            {sections.map((section) => (
              <EnhancedSectionCard
                key={section.id}
                section={section}
                trip={trip}
                participants={participants}
                isAdmin={isAdmin}
                currentUserId={user?.id || ''}
                onUpdate={fetchPlanningSections}
                onSelectionUpdate={handleSelectionUpdate}
                onCreateOption={handleCreateOption}
                onEditSection={(sec) => {
                  setEditingSection(sec)
                  setCreateSectionModalOpen(true)
                }}
                onDeleteSection={async (sec) => {
                  const optionCount = (sec.options || []).length
                  const totalSelections = (sec.options || []).reduce(
                    (sum: number, opt: any) => sum + (opt.selections || []).length,
                    0
                  )

                  let confirmMessage = `Delete section "${sec.title}"?`

                  if (optionCount > 0) {
                    confirmMessage = `Delete section "${sec.title}"?\n\nThis section has ${optionCount} option(s)${totalSelections > 0 ? ` with ${totalSelections} selection(s)` : ''}. All will be permanently deleted.`
                  }

                  if (!window.confirm(confirmMessage)) {
                    return
                  }

                  const { error } = await supabase
                    .from('planning_sections')
                    .delete()
                    .eq('id', sec.id)

                  if (error) {
                    alert(`Error deleting section: ${error.message}`)
                  } else {
                    fetchPlanningSections()
                  }
                }}
              />
            ))}
          </div>

          {/* Selection Summary Sidebar */}
          <div className="lg:col-span-1">
            <SelectionSummaryV2
              sections={sections}
              userId={user?.id || ''}
            />
          </div>
        </div>
      </div>

      {/* Modals */}
      <CreatePlanningSectionModal
        isOpen={createSectionModalOpen}
        onClose={() => {
          setCreateSectionModalOpen(false)
          setEditingSection(null)
        }}
        tripId={trip.id}
        onSuccess={fetchPlanningSections}
        section={editingSection}
      />

      {selectedSectionId && (
        <CreateOptionModal
          isOpen={createOptionModalOpen}
          onClose={() => {
            setCreateOptionModalOpen(false)
            setSelectedSectionId(null)
            setEditingOption(null)
          }}
          sectionId={selectedSectionId}
          option={editingOption}
          onSuccess={fetchPlanningSections}
        />
      )}
    </>
  )
}

// Enhanced Section Card with Matrix support and Quick Add
function EnhancedSectionCard({
  section,
  trip,
  participants,
  isAdmin,
  currentUserId,
  onUpdate,
  onSelectionUpdate,
  onCreateOption,
  onEditSection,
  onDeleteSection,
}: {
  section: any
  trip: Trip
  participants: ParticipantWithUser[]
  isAdmin: boolean
  currentUserId: string
  onUpdate: () => void
  onSelectionUpdate: (sectionId: string, optionId: string, userId: string, action: 'add' | 'remove', newSelection?: any) => void
  onCreateOption: (sectionId: string, option?: any) => void
  onEditSection: (section: any) => void
  onDeleteSection: (section: any) => void
}) {
  const { user } = useAuth()
  const [isExpanded, setIsExpanded] = useState(false)
  const [showQuickAdd, setShowQuickAdd] = useState(false)
  const [showPendingModal, setShowPendingModal] = useState(false)

  const options = section.options || []
  const availableOptions = options.filter((opt: any) => opt.status !== 'draft' && opt.status !== 'cancelled')

  // Detect if this section should use matrix view
  // Check if section type is 'equipment' or if options have grid metadata
  const hasGridMetadata = options.some((opt: any) => opt.metadata?.grid_row && opt.metadata?.grid_column)
  const isEquipmentSection = section.section_type === 'equipment'
  const shouldUseMatrixView = hasGridMetadata || (isEquipmentSection && options.length > 6)

  // Extract grid structure from options
  const getGridStructure = () => {
    const rows = new Set<string>()
    const columns = new Set<string>()

    options.forEach((opt: any) => {
      if (opt.metadata?.grid_row) rows.add(opt.metadata.grid_row)
      if (opt.metadata?.grid_column) columns.add(opt.metadata.grid_column)
    })

    // If no explicit metadata, try to infer from titles
    if (rows.size === 0 && isEquipmentSection) {
      // Try to parse titles like "🎿 Skis Only - Level A (Novice)"
      options.forEach((opt: any) => {
        const title = opt.title || ''
        // Extract level
        const levelMatch = title.match(/Level\s+([A-D])\s*\(([^)]+)\)/i)
        if (levelMatch) {
          rows.add(`Level ${levelMatch[1]} (${levelMatch[2]})`)
        }
        // Extract package type
        if (title.includes('Full Kit')) columns.add('Full Kit')
        else if (title.includes('Skis + Boots') || title.includes('Skis+Boots')) columns.add('Skis + Boots')
        else if (title.includes('Skis Only')) columns.add('Skis Only')
      })
    }

    return {
      rows: Array.from(rows).sort(),
      columns: Array.from(columns).sort((a, b) => {
        // Sort by price tier: Skis Only < Skis + Boots < Full Kit
        const order: Record<string, number> = { 'Skis Only': 1, 'Skis + Boots': 2, 'Full Kit': 3 }
        return (order[a] || 99) - (order[b] || 99)
      })
    }
  }

  // Calculate selection stats
  const participantIds = participants.map(p => p.user_id)
  const usersWhoSelected = new Set(
    options.flatMap((opt: any) =>
      (opt.selections || [])
        .filter((sel: any) => participantIds.includes(sel.user_id))
        .map((sel: any) => sel.user_id)
    )
  )
  const selectionsCount = usersWhoSelected.size
  const participantsWithoutSelection = participants.filter(p => !usersWhoSelected.has(p.user_id))
  const userHasSelected = options.some((opt: any) =>
    (opt.selections || []).some((sel: any) => sel.user_id === currentUserId)
  )

  // Handle selection for matrix view
  const handleMatrixSelect = async (optionId: string) => {
    if (!user) return

    const option = options.find((o: any) => o.id === optionId)
    if (!option || option.locked) return

    const userSelection = option.selections?.find((s: any) => s.user_id === user.id)
    const isSelected = !!userSelection

    if (isSelected) {
      // Deselect
      onSelectionUpdate(section.id, optionId, user.id, 'remove')
      await supabase.from('selections').delete().eq('id', userSelection.id)
    } else {
      // For single-choice, delete existing selections first
      if (!section.allow_multiple_selections) {
        const sectionOptionIds = options.map((o: any) => o.id)
        await supabase
          .from('selections')
          .delete()
          .eq('user_id', user.id)
          .in('option_id', sectionOptionIds)
      }

      // Get user data for display
      const { data: userData } = await supabase
        .from('users')
        .select('*')
        .eq('id', user.id)
        .single()

      // Insert new selection
      const { data: newSel } = await supabase
        .from('selections')
        .insert({ option_id: optionId, user_id: user.id, metadata: {} })
        .select()
        .single()

      if (newSel) {
        onSelectionUpdate(section.id, optionId, user.id, 'add', { ...newSel, user: userData })
      }
    }
  }

  const gridStructure = getGridStructure()

  return (
    <Card className="!p-4 isolate">
      <Card.Header>
        <div
          className="cursor-pointer select-none"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 flex-1 min-w-0">
              {/* Chevron */}
              <button
                className="text-gray-400 hover:text-gray-600 transition-colors mt-0.5 flex-shrink-0"
                onClick={(e) => {
                  e.stopPropagation()
                  setIsExpanded(!isExpanded)
                }}
              >
                <svg
                  className={`w-5 h-5 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>

              {/* Title and badges */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Card.Title className="!mb-0">{section.title}</Card.Title>
                  <Badge
                    variant={
                      section.status === 'completed'
                        ? 'success'
                        : section.status === 'in_progress'
                        ? 'info'
                        : 'neutral'
                    }
                  >
                    {section.status.replace('_', ' ')}
                  </Badge>
                  {shouldUseMatrixView && (
                    <Badge variant="neutral" className="text-xs">
                      Grid View
                    </Badge>
                  )}
                  {!userHasSelected && availableOptions.length > 0 && (
                    <Badge variant="warning" className="animate-pulse">
                      Action Needed
                    </Badge>
                  )}
                </div>

                {/* Description with Markdown */}
                {section.description && (
                  <div className="mt-1 text-sm text-gray-600">
                    <ReactMarkdown remarkPlugins={[remarkBreaks]}>
                      {section.description}
                    </ReactMarkdown>
                  </div>
                )}

                {/* Stats */}
                <div className="mt-2 flex items-center gap-4 text-sm text-gray-600">
                  <span
                    onClick={(e) => {
                      e.stopPropagation()
                      if (participantsWithoutSelection.length > 0) {
                        setShowPendingModal(true)
                      }
                    }}
                    className={participantsWithoutSelection.length > 0 ? 'cursor-pointer hover:text-sky-600 hover:underline transition-colors' : ''}
                  >
                    {selectionsCount} of {participants.length} selected
                  </span>
                  {availableOptions.length > 0 && (
                    <span className="text-gray-400">
                      • {availableOptions.length} options
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Admin buttons */}
            {isAdmin && (
              <div className="flex gap-1 flex-shrink-0">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onEditSection(section)
                  }}
                  className="text-xs text-sky-600 hover:text-sky-700 px-2 py-1 rounded hover:bg-sky-50"
                >
                  Edit
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteSection(section)
                  }}
                  className="text-xs text-red-600 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50"
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Admin quick actions when expanded */}
        {isExpanded && isAdmin && (
          <div className="mt-3 pt-3 border-t border-gray-200 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onCreateOption(section.id)}
            >
              + Add Option
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowQuickAdd(!showQuickAdd)}
            >
              {showQuickAdd ? 'Cancel Quick Add' : '⚡ Quick Add Multiple'}
            </Button>
          </div>
        )}
      </Card.Header>

      {/* Content */}
      {isExpanded && (
        <Card.Content>
          {/* Quick Add Panel */}
          {showQuickAdd && isAdmin && (
            <QuickAddOptions
              sectionId={section.id}
              onSuccess={() => {
                setShowQuickAdd(false)
                onUpdate()
              }}
              onCancel={() => setShowQuickAdd(false)}
            />
          )}

          {availableOptions.length === 0 ? (
            <EmptyState
              icon="📝"
              title="No options yet"
              description={isAdmin ? "Add options for this section" : "No options available yet"}
              action={
                isAdmin ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => onCreateOption(section.id)}
                  >
                    + Add Option
                  </Button>
                ) : undefined
              }
            />
          ) : shouldUseMatrixView && gridStructure.rows.length > 0 && gridStructure.columns.length > 0 ? (
            /* Matrix View */
            <div className="mt-4">
              <MatrixSelector
                options={availableOptions.map((opt: any) => ({
                  ...opt,
                  metadata: {
                    ...opt.metadata,
                    // Infer grid position from title if not set
                    grid_row: opt.metadata?.grid_row || inferGridRow(opt.title),
                    grid_column: opt.metadata?.grid_column || inferGridColumn(opt.title),
                  }
                }))}
                rows={gridStructure.rows}
                columns={gridStructure.columns}
                currentUserId={currentUserId}
                onSelect={handleMatrixSelect}
                disabled={isTripLocked(trip.status)}
                showPrices={true}
                currency={options[0]?.currency || 'EUR'}
              />
            </div>
          ) : (
            /* Standard List View */
            <div className="space-y-3 mt-4">
              {availableOptions.map((option: any) => (
                <OptionCardV2
                  key={option.id}
                  option={option}
                  section={section}
                  isAdmin={isAdmin}
                  isLocked={isTripLocked(trip.status) || option.locked}
                  onSelectionUpdate={onSelectionUpdate}
                  onEdit={(opt) => onCreateOption(section.id, opt)}
                  onDelete={async (opt) => {
                    const selectionCount = (opt.selections || []).length
                    if (!window.confirm(
                      selectionCount > 0
                        ? `Delete "${opt.title}"? ${selectionCount} selections will be lost.`
                        : `Delete "${opt.title}"?`
                    )) return

                    await supabase.from('options').delete().eq('id', opt.id)
                    onUpdate()
                  }}
                />
              ))}
            </div>
          )}
        </Card.Content>
      )}

      {/* Pending Modal */}
      {showPendingModal && (
        <PendingSelectionsModal
          section={section}
          participants={participantsWithoutSelection}
          onClose={() => setShowPendingModal(false)}
        />
      )}
    </Card>
  )
}

// Helper to infer grid row from title
function inferGridRow(title: string): string | undefined {
  const match = title.match(/Level\s+([A-D])\s*\(([^)]+)\)/i)
  if (match) return `Level ${match[1]} (${match[2]})`
  return undefined
}

// Helper to infer grid column from title
function inferGridColumn(title: string): string | undefined {
  if (title.includes('Full Kit')) return 'Full Kit'
  if (title.includes('Skis + Boots') || title.includes('Skis+Boots') || title.includes('🎿🥾')) return 'Skis + Boots'
  if (title.includes('Skis Only') || title.match(/^🎿\s*Skis Only/)) return 'Skis Only'
  return undefined
}

// Simplified Option Card
function OptionCardV2({
  option,
  section,
  isAdmin,
  isLocked,
  onSelectionUpdate,
  onEdit,
  onDelete,
}: {
  option: any
  section: any
  isAdmin: boolean
  isLocked: boolean
  onSelectionUpdate: (sectionId: string, optionId: string, userId: string, action: 'add' | 'remove', newSelection?: any) => void
  onEdit: (option: any) => void
  onDelete: (option: any) => void
}) {
  const { user } = useAuth()
  const selections = option.selections || []
  const userSelection = selections.find((sel: any) => sel.user_id === user?.id)
  const isSelected = !!userSelection

  const handleToggle = async () => {
    if (isLocked || !user) return

    if (isSelected) {
      onSelectionUpdate(section.id, option.id, user.id, 'remove')
      await supabase.from('selections').delete().eq('id', userSelection.id)
    } else {
      if (!section.allow_multiple_selections) {
        const sectionOptionIds = (section.options || []).map((o: any) => o.id)
        await supabase
          .from('selections')
          .delete()
          .eq('user_id', user.id)
          .in('option_id', sectionOptionIds)
      }

      const { data: userData } = await supabase
        .from('users')
        .select('*')
        .eq('id', user.id)
        .single()

      const { data: newSel } = await supabase
        .from('selections')
        .insert({ option_id: option.id, user_id: user.id, metadata: {} })
        .select()
        .single()

      if (newSel) {
        onSelectionUpdate(section.id, option.id, user.id, 'add', { ...newSel, user: userData })
      }
    }
  }

  return (
    <div
      className={`border rounded-lg p-4 transition-all ${
        isSelected
          ? 'border-sky-500 bg-sky-50'
          : 'border-gray-200 hover:border-gray-300'
      } ${isLocked ? 'opacity-75' : ''}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <h4 className="font-medium text-gray-900">{option.title}</h4>
            {option.status && option.status !== 'available' && (
              <Badge
                variant={
                  option.status === 'booked' ? 'success' : option.status === 'booking' ? 'info' : 'neutral'
                }
                className="text-xs"
              >
                {option.status}
              </Badge>
            )}
            {isLocked && <span className="text-xs text-gray-500">🔒</span>}
            {isAdmin && (
              <div className="flex gap-1 ml-auto">
                <button onClick={() => onEdit(option)} className="text-xs text-sky-600 hover:text-sky-700 px-2 py-1">
                  Edit
                </button>
                <button onClick={() => onDelete(option)} className="text-xs text-red-600 hover:text-red-700 px-2 py-1">
                  Delete
                </button>
              </div>
            )}
          </div>

          {option.description && (
            <div className="text-sm text-gray-600 mb-3">
              <ReactMarkdown remarkPlugins={[remarkBreaks]}>{option.description}</ReactMarkdown>
            </div>
          )}

          {option.price && (
            <div className="mb-3">
              <span className="text-lg font-bold text-gray-900">
                {option.currency || 'EUR'} {option.price.toFixed(2)}
              </span>
              <span className="text-sm text-gray-600 ml-2">per person</span>
            </div>
          )}

          {selections.length > 0 && (
            <div className="flex items-center gap-2 mb-3">
              <span className="text-sm text-gray-600">Selected by:</span>
              <SelectionAvatars selections={selections} maxAvatars={3} size="sm" />
            </div>
          )}
        </div>

        <Button
          variant={isSelected ? 'outline' : 'primary'}
          size="sm"
          onClick={handleToggle}
          disabled={isLocked}
          className="flex-shrink-0"
        >
          {isSelected ? '✓ Selected' : 'Select'}
        </Button>
      </div>
    </div>
  )
}

// Selection Summary with more detail
function SelectionSummaryV2({
  sections,
  userId,
}: {
  sections: any[]
  userId: string
}) {
  let totalCost = 0
  const userSelections: Array<{ section: string; option: string; price?: number; currency?: string }> = []

  sections.forEach((section) => {
    (section.options || []).forEach((option: any) => {
      const sel = (option.selections || []).find((s: any) => s.user_id === userId)
      if (sel) {
        userSelections.push({
          section: section.title,
          option: option.title,
          price: option.price,
          currency: option.currency,
        })
        if (option.price) {
          totalCost += option.price
        }
      }
    })
  })

  // Count how many sections user hasn't selected in
  const sectionsWithOptions = sections.filter(s => (s.options || []).some((o: any) => o.status !== 'draft' && o.status !== 'cancelled'))
  const sectionsWithUserSelection = new Set(userSelections.map(s => s.section))
  const pendingSections = sectionsWithOptions.filter(s => !sectionsWithUserSelection.has(s.title))

  return (
    <div className="sticky top-4">
      <Card className="!p-4">
        <Card.Header>
          <Card.Title className="!mb-0">Your Selections</Card.Title>
        </Card.Header>
        <Card.Content>
          {userSelections.length === 0 ? (
            <p className="text-sm text-gray-500">No selections yet</p>
          ) : (
            <div className="space-y-3">
              {userSelections.map((sel, i) => (
                <div key={i} className="text-sm">
                  <div className="text-gray-500">{sel.section}</div>
                  <div className="font-medium text-gray-900 flex justify-between">
                    <span className="truncate pr-2">{sel.option}</span>
                    {sel.price && (
                      <span className="text-sky-600 flex-shrink-0">
                        {sel.currency || 'EUR'} {sel.price.toFixed(0)}
                      </span>
                    )}
                  </div>
                </div>
              ))}

              {totalCost > 0 && (
                <div className="pt-3 border-t border-gray-200">
                  <div className="flex justify-between font-semibold">
                    <span>Estimated Total</span>
                    <span className="text-sky-600">EUR {totalCost.toFixed(2)}</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Pending sections warning */}
          {pendingSections.length > 0 && (
            <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <p className="text-sm font-medium text-amber-800">
                {pendingSections.length} section{pendingSections.length > 1 ? 's' : ''} need your selection:
              </p>
              <ul className="mt-1 text-sm text-amber-700">
                {pendingSections.map(s => (
                  <li key={s.id}>• {s.title}</li>
                ))}
              </ul>
            </div>
          )}
        </Card.Content>
      </Card>
    </div>
  )
}

// Pending selections modal
function PendingSelectionsModal({
  section,
  participants,
  onClose,
}: {
  section: any
  participants: ParticipantWithUser[]
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center p-4 bg-black bg-opacity-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[80vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">Pending Selections</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto max-h-[60vh]">
          <p className="text-sm text-gray-600 mb-4">
            {participants.length} {participants.length === 1 ? "person hasn't" : "people haven't"} selected for "{section.title}":
          </p>
          <div className="space-y-2">
            {participants.map((p) => (
              <div key={p.user_id} className="flex items-center gap-3 p-2 bg-gray-50 rounded-lg">
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-sm overflow-hidden"
                  style={{ backgroundColor: (p.user?.avatar_data as any)?.bgColor || '#0ea5e9' }}
                >
                  {(p.user?.avatar_data as any)?.emoji || '😊'}
                </div>
                <span className="text-sm font-medium text-gray-900">
                  {p.user?.full_name || p.user?.email || 'Unknown'}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-gray-200 px-6 py-4">
          <Button variant="outline" onClick={onClose} className="w-full">
            Close
          </Button>
        </div>
      </div>
    </div>
  )
}
