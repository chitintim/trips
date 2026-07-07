import { useMemo, useState } from 'react'
import { useAuth } from '../../../hooks/useAuth'
import { Button, EmptyState, Skeleton } from '../../../components/ui'
import { useParticipants } from '../../../lib/queries/useTrip'
import { useSections, useVotes, useReactions, useComments } from '../../../lib/queries/usePlanning'
import { getDecisionShape } from '../lib/decisionShapes'
import type { Option } from '../../../types'
import type { OptionDraft } from '../../../shared/contracts'
import { SectionCard } from './SectionCard'
import { SectionEditorSheet } from './SectionEditorSheet'
import { OptionEditorSheet } from './OptionEditorSheet'
import { PasteALinkSheet } from './PasteALinkSheet'

interface DecisionsTabProps {
  tripId: string
}

/**
 * Trip "Decisions" tab: sections-as-polls with voting, cost impact,
 * matrix view, reactions, comments, and paste-a-link option creation.
 * Exported as the Component in src/features/decisions/index.ts for the
 * coordinator to wire into TripDetail's tab config.
 */
export function DecisionsTab({ tripId }: DecisionsTabProps) {
  const { user } = useAuth()
  const { data: participants, isLoading: participantsLoading } = useParticipants(tripId)
  const { data: sections, isLoading: sectionsLoading } = useSections(tripId)
  const { data: votes } = useVotes(tripId)
  const { data: reactions } = useReactions(tripId)
  const sectionIds = useMemo(() => (sections || []).map((s) => s.id), [sections])
  const { data: comments } = useComments(tripId, sectionIds)

  const [sectionSheetOpen, setSectionSheetOpen] = useState(false)
  const [optionSheet, setOptionSheet] = useState<{ sectionId: string; option: Option | null; prefillDraft?: OptionDraft | null } | null>(null)
  const [pasteLinkOpen, setPasteLinkOpen] = useState(false)
  const [pasteLinkTargetSection, setPasteLinkTargetSection] = useState<string | null>(null)

  const myParticipant = participants?.find((p) => p.user_id === user?.id)
  const isOrganizer = myParticipant?.role === 'organizer'
  const confirmedCount = (participants || []).filter((p) => p.confirmation_status === 'confirmed').length

  if (sectionsLoading || participantsLoading) {
    return (
      <div className="p-4 space-y-4">
        <Skeleton variant="card" height={200} />
        <Skeleton variant="card" height={200} />
      </div>
    )
  }

  const findOptionById = (optionId: string): Option | null => {
    for (const section of sections || []) {
      const found = section.options.find((o) => o.id === optionId)
      if (found) return found
    }
    return null
  }

  return (
    <div className="p-4 space-y-4 max-w-2xl mx-auto">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Decisions</h2>
        {isOrganizer && (
          <Button size="sm" onClick={() => setSectionSheetOpen(true)}>
            + New section
          </Button>
        )}
      </div>

      {(sections || []).length === 0 ? (
        <EmptyState
          icon="🗳️"
          title="No sections yet"
          description={
            isOrganizer
              ? 'Start by creating a section like Accommodation, Flights, or Activities.'
              : 'The trip organizer will add planning sections soon.'
          }
          action={
            isOrganizer ? (
              <Button onClick={() => setSectionSheetOpen(true)}>+ Create section</Button>
            ) : undefined
          }
        />
      ) : (
        (sections || []).map((section) => (
          <SectionCard
            key={section.id}
            tripId={tripId}
            section={section}
            votes={votes || []}
            reactions={reactions || []}
            comments={comments || []}
            participants={participants || []}
            confirmedCount={confirmedCount}
            isOrganizer={isOrganizer}
            onAddOption={() => setOptionSheet({ sectionId: section.id, option: null })}
            onEditOption={(optionId) => setOptionSheet({ sectionId: section.id, option: findOptionById(optionId) })}
            onAddFromLink={() => {
              setPasteLinkTargetSection(section.id)
              setPasteLinkOpen(true)
            }}
          />
        ))
      )}

      <SectionEditorSheet isOpen={sectionSheetOpen} onClose={() => setSectionSheetOpen(false)} tripId={tripId} section={null} />

      {optionSheet && (
        <OptionEditorSheet
          isOpen
          onClose={() => setOptionSheet(null)}
          tripId={tripId}
          sectionId={optionSheet.sectionId}
          option={optionSheet.option}
          prefillDraft={optionSheet.prefillDraft}
          decisionShape={getDecisionShape((sections || []).find((s) => s.id === optionSheet.sectionId)?.metadata)}
        />
      )}

      <PasteALinkSheet
        isOpen={pasteLinkOpen}
        onClose={() => {
          setPasteLinkOpen(false)
          setPasteLinkTargetSection(null)
        }}
        tripId={tripId}
        onApproved={(draft) => {
          const targetSectionId = pasteLinkTargetSection || sections?.[0]?.id
          setPasteLinkOpen(false)
          if (targetSectionId) {
            setOptionSheet({ sectionId: targetSectionId, option: null, prefillDraft: draft })
          }
        }}
      />
    </div>
  )
}
